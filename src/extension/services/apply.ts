/**
 * The apply pipeline (section 9): apply leases, form answers, results, tracker, reconcile.
 * Tracker reads land here from build phase 4; the rest is phase 5.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { rulesOf } from "../../platforms/config.js";
import { getState, linkedinCap, mergeState, startOfDay } from "../../services/automation.js";
import { getPreferences } from "../../services/candidate.js";
import type { DeviceAuth } from "../auth/requireDevice.js";
import type { Cap } from "../contract.js";
import { logEvent } from "./events.js";
import { completeLease, getLease, type LeaseRow } from "./leases.js";
import { ownRun, patchRunMeta } from "./sessions.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

/** An apply lease that expired (the extension vanished mid-job) counts as ERR for its job. */
export async function settleExpiredApplies(_leases: LeaseRow[]): Promise<void> {}

async function userTimezone(userId: string) {
  const { data } = await db().from("profiles").select("timezone").eq("id", userId).maybeSingle();
  return data?.timezone || "Asia/Kolkata";
}

/**
 * POST /linkedin/tracker: LinkedIn's own Applied count, read in the worker tab. Stored exactly as
 * the MCP's private noteTracker stores it (src/services/automation.ts; three lines, reimplemented
 * because it is not exported), so linkedinCap counts the tracker's movement for the day, which
 * includes the user's own applications. The run keeps its first and last reading for the end check.
 */
export async function recordTracker(dev: DeviceAuth, input: { lease_id: string; count: number | null }): Promise<{ cap: Cap }> {
  const { userId } = dev;
  const lease = await getLease(userId, input.lease_id, dev.deviceId, "tracker");
  const done = await completeLease(userId, lease, input.count == null ? "NO_COUNT" : "OK", { count: input.count });
  if (done.first && input.count != null) {
    const since = startOfDay(await userTimezone(userId)).toISOString();
    const st = ((await getState(userId, "linkedin"))?.state as Meta) ?? {};
    const t = st.tracker?.day === since ? st.tracker : { day: since, first: input.count };
    await mergeState(userId, "linkedin", { tracker: { ...t, last: input.count } });
    try {
      const run = await ownRun(userId, dev.deviceId, lease.run_id);
      await patchRunMeta(userId, run, {
        tracker_first: run.metadata.tracker_first ?? input.count,
        tracker_last: input.count,
        tracker_at_applies: run.metadata.applies_done ?? 0,
      });
    } catch {
      /* the run ended meanwhile: the day's reading above is what matters */
    }
  }
  const cap = await linkedinCap(userId, rulesOf(await getPreferences(userId)));
  return { cap: { cap: cap.cap, used: cap.used, left: cap.left } };
}

/**
 * At the end of a run: did LinkedIn's Applied count move as much as this run's submissions
 * (SENT and UNCONFIRMED)? Less means some UNCONFIRMED jobs did not land; they are verified by a
 * later apply/next (section 9.1 step 6). Logged as a warning event and shown in the side panel.
 */
export async function trackerCheck(userId: string, runId: string, meta: Meta) {
  if (meta.tracker_first == null || meta.tracker_last == null) return null;
  // Only a reading taken after the run's last apply can judge it.
  if (Number(meta.tracker_at_applies ?? 0) < Number(meta.applies_done ?? 0)) return null;
  const { data, error } = await db()
    .from("applications")
    .select("metadata")
    .eq("user_id", userId)
    .eq("run_id", runId)
    .in("status", ["applied", "unconfirmed"])
    .eq("applied_by", "aupply")
    .limit(500);
  if (error) throw error;
  const recorded = (data ?? []).filter((a) => /^(SENT|UNCONFIRMED)$/.test(String((a.metadata as Meta | null)?.last_result ?? ""))).length;
  const moved = Number(meta.tracker_last) - Number(meta.tracker_first);
  if (moved >= recorded) return null;
  await logEvent(userId, { runId, level: "warn", type: "tracker.mismatch", data: { moved, recorded } });
  return { moved, recorded };
}
