/**
 * Extension sessions: rows in the existing `runs` table with client 'aupply_extension'
 * (decision E11), so the MCP's start_session sees a live extension run as another_run_live
 * without any MCP change. metadata: { channel, device_id, posted_within, mode, phase,
 * last_heartbeat_at, slow, rate_limited }.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { unwrap } from "../../lib/errors.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

export const EXT_CLIENT = "aupply_extension";
/** A run with a heartbeat this recent is live (another device must wait). */
export const LIVE_MS = 3 * 60_000;
/** A run with no heartbeat for this long is ended by cleanup. */
export const STALE_MS = 30 * 60_000;

const lastBeat = (r: { started_at: string; metadata: unknown }) => {
  const m = (r.metadata as Meta | null) ?? {};
  return Date.parse(typeof m.last_heartbeat_at === "string" ? m.last_heartbeat_at : r.started_at);
};

/** This user's open extension runs, newest first. */
export async function openRuns(userId: string) {
  return unwrap(
    await db()
      .from("runs")
      .select("id, started_at, metadata")
      .eq("user_id", userId)
      .eq("client", EXT_CLIENT)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(20)
  );
}

/** The live extension run, if any, with the name of the device running it. */
export async function liveRun(userId: string) {
  const now = Date.now();
  const run = (await openRuns(userId)).find((r) => now - lastBeat(r) < LIVE_MS);
  if (!run) return null;
  const m = (run.metadata as Meta | null) ?? {};
  const device = m.device_id
    ? (await db().from("ext_devices").select("name").eq("id", m.device_id).eq("user_id", userId).maybeSingle()).data
    : null;
  return { run_id: run.id, device_id: (m.device_id as string | undefined) ?? null, device_name: device?.name ?? null, phase: (m.phase as string | undefined) ?? null };
}
