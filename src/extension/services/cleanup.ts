/**
 * Cleanup (section 7.10): the daily cron for every user, and the same steps lazily for one
 * user at session/start. Ends extension runs with no heartbeat for 30 minutes, closes expired
 * leases, deletes pairings that expired more than a day ago and events older than 30 days.
 */

import crypto from "node:crypto";
import type { Request } from "express";
import { getSupabaseClient } from "../../db/supabase.js";
import { check, unwrap } from "../../lib/errors.js";
import { unauthorized } from "../server/http.js";
import { closeExpiredLeases } from "./leases.js";
import { EXT_CLIENT, STALE_MS } from "./sessions.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

/** Vercel cron sends Authorization: Bearer <CRON_SECRET>. No secret configured: nothing passes. */
export function requireCron(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  if (!secret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw unauthorized("Not allowed.");
}

/** End extension runs whose last heartbeat is older than 30 minutes (one user, or everyone). */
export async function endStaleRuns(userId?: string) {
  let q = db().from("runs").select("id, user_id, started_at, metadata").eq("client", EXT_CLIENT).is("ended_at", null);
  if (userId) q = q.eq("user_id", userId);
  const rows = unwrap(await q.limit(1000));
  const cutoff = Date.now() - STALE_MS;
  let ended = 0;
  for (const r of rows) {
    const m = (r.metadata as Meta | null) ?? {};
    const beat = Date.parse(typeof m.last_heartbeat_at === "string" ? m.last_heartbeat_at : r.started_at);
    if (beat >= cutoff) continue;
    check(
      await db()
        .from("runs")
        .update({ ended_at: new Date().toISOString(), summary: "ended: no heartbeat" })
        .eq("id", r.id)
        .eq("user_id", r.user_id)
        .is("ended_at", null)
    );
    // Its open leases go with it.
    check(
      await db()
        .from("ext_leases")
        .update({ completed_at: new Date().toISOString(), result: "ABORTED" })
        .eq("user_id", r.user_id)
        .eq("run_id", r.id)
        .is("completed_at", null)
    );
    ended++;
  }
  return ended;
}

export async function cleanupAll() {
  const now = Date.now();
  const runs = await endStaleRuns();
  const leases = await closeExpiredLeases();
  const pairings = unwrap(
    await db().from("ext_pairings").delete().lt("expires_at", new Date(now - 24 * 3600_000).toISOString()).select("id")
  ).length;
  const events = unwrap(
    await db().from("ext_events").delete().lt("created_at", new Date(now - 30 * 24 * 3600_000).toISOString()).select("id")
  ).length;
  return { ok: true as const, runs_ended: runs, leases_expired: leases, pairings_deleted: pairings, events_deleted: events };
}
