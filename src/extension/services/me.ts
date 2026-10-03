/**
 * GET /me: everything the side panel's home needs in one call (section 7.5).
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { defaultWithin, rulesOf } from "../../platforms/config.js";
import { activeBlock, linkedinCap } from "../../services/automation.js";
import { getPreferences, getProfile, setupGaps } from "../../services/candidate.js";
import type { DeviceAuth } from "../auth/requireDevice.js";
import type { MeResponse } from "../contract.js";
import { linkedinEnabled, minVersion } from "../server/http.js";
import { EXT_VERSION } from "../version.js";
import { decisionCount, linkedinQueue } from "./queue.js";
import { liveRun } from "./sessions.js";

const db = () => getSupabaseClient();

async function count(q: PromiseLike<{ count: number | null; error: unknown }>) {
  const { count: n, error } = await q;
  if (error) throw error;
  return n ?? 0;
}

export async function me(dev: DeviceAuth): Promise<MeResponse> {
  const { userId } = dev;
  const [profile, prefs] = await Promise.all([getProfile(userId), getPreferences(userId)]);
  const within = defaultWithin(prefs.max_posting_age_hours);
  const [cap, blocked, queue, decisions, live, openQuestions, provisional] = await Promise.all([
    linkedinCap(userId, rulesOf(prefs)),
    activeBlock(userId, ["linkedin", "linkedin_guest"]),
    linkedinQueue(userId, within),
    decisionCount(userId),
    liveRun(userId),
    count(db().from("ext_questions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "open")),
    count(
      db()
        .from("answers")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "provisional")
        .eq("metadata->>origin", "extension_ai")
    ),
  ]);
  let email = profile.email;
  if (!email) email = (await db().auth.admin.getUserById(userId)).data.user?.email ?? null;
  return {
    user: { email, full_name: profile.full_name },
    device: { id: dev.deviceId, name: dev.name },
    setup_gaps: setupGaps(profile, prefs),
    linkedin: {
      enabled: linkedinEnabled(),
      cap: { cap: cap.cap, used: cap.used, left: cap.left },
      blocked,
      queue: { ready: queue.ready.length, waiting_on_you: queue.waiting.length, decisions },
      posted_within_default: within,
      live_run: live ? { run_id: live.run_id, device_name: live.device_name, phase: live.phase, this_device: live.device_id === dev.deviceId } : null,
    },
    open_questions: openQuestions,
    provisional_to_review: provisional,
    versions: { latest: EXT_VERSION, min: minVersion() },
  };
}
