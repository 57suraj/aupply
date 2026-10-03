/**
 * ext_events: a small log for debugging live runs (errors, stops, versions, pacing). Never
 * holds tokens, answer values, resume text or JD text. Pruned after 30 days by the cleanup
 * cron. Logging never fails the request it belongs to.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import type { ClientEvent } from "../contract.js";

const db = () => getSupabaseClient();
const MAX_DATA = 2048;

type Level = "debug" | "info" | "warn" | "error";

/** At most 2KB of data per event: anything larger keeps only its keys. */
function bounded(data: Record<string, unknown>): Json {
  const s = JSON.stringify(data ?? {});
  return (s.length <= MAX_DATA ? JSON.parse(s) : { truncated: true, keys: Object.keys(data).slice(0, 40) }) as Json;
}

export async function logEvent(
  userId: string,
  e: { deviceId?: string | null; runId?: string | null; level: Level; type: string; data?: Record<string, unknown> }
) {
  const { error } = await db().from("ext_events").insert({
    user_id: userId,
    device_id: e.deviceId ?? null,
    run_id: e.runId ?? null,
    level: e.level,
    type: e.type,
    data: bounded(e.data ?? {}),
  });
  if (error) console.error("[ext] event log failed", e.type, error.message);
}

/** POST /events: the extension's own log lines (at most 50 per call). A run id that is not
    this user's is dropped rather than failing the batch. */
export async function logClientEvents(userId: string, deviceId: string, events: ClientEvent[]) {
  const runIds = [...new Set(events.map((e) => e.run_id).filter(Boolean))] as string[];
  const own = new Set<string>();
  if (runIds.length) {
    const { data } = await db().from("runs").select("id").eq("user_id", userId).in("id", runIds);
    (data ?? []).forEach((r) => own.add(r.id));
  }
  const rows = events.map((e) => ({
    user_id: userId,
    device_id: deviceId,
    run_id: e.run_id && own.has(e.run_id) ? e.run_id : null,
    level: e.level,
    type: `client.${e.type}`.slice(0, 80),
    data: bounded({ ...e.data, ...(e.at ? { at: e.at } : {}) }),
  }));
  const { error } = await db().from("ext_events").insert(rows);
  if (error) console.error("[ext] client events failed", error.message);
  return { ok: true as const };
}
