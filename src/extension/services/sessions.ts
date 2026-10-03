/**
 * Extension sessions: rows in the existing `runs` table with client 'aupply_extension'
 * (decision E11), so the MCP's start_session sees a live extension run as another_run_live
 * without any MCP change. metadata: { channel, device_id, posted_within, mode, keywords,
 * target, phase, hidden, last_heartbeat_at, slow, rate_limited, applies_done, tracker }.
 *
 * Only one LinkedIn loop per account (docs/automation-tools.md, Rate limits): a second device
 * waits while one is live, and the extension waits while Claude works LinkedIn through the MCP
 * (read-only checks of what the MCP writes; nothing on the MCP side changes).
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { check, unwrap, unwrapMaybe } from "../../lib/errors.js";
import { defaultWithin, rulesOf } from "../../platforms/config.js";
import { activeBlock, getState, linkedinCap } from "../../services/automation.js";
import { getPreferences, getProfile, setupGaps } from "../../services/candidate.js";
import type { DeviceAuth } from "../auth/requireDevice.js";
import type { HeartbeatResponse, PostedWithin, SessionEndResponse, SessionStartRequest, SessionStartResponse } from "../contract.js";
import { conflict, DISABLED_MESSAGE, linkedinEnabled } from "../server/http.js";
import { endStaleRuns } from "./cleanup.js";
import { isSubscribed } from "./entitlement.js";
import { logEvent } from "./events.js";
import { closeExpiredLeases, issueLease } from "./leases.js";
import { linkedinQueue } from "./queue.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

export const EXT_CLIENT = "aupply_extension";
/** A run with a heartbeat this recent is live (another device must wait). */
export const LIVE_MS = 3 * 60_000;
/** A run with no heartbeat for this long is ended by cleanup. */
export const STALE_MS = 30 * 60_000;
/** The MCP's QUEUE_ENOUGH.linkedin: with this many ready jobs a run skips the draft. */
export const EXT_QUEUE_ENOUGH = 10;
export const TRACKER_URL = "https://www.linkedin.com/jobs-tracker/?stage=applied";

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

export type RunRow = { id: string; started_at: string; ended_at: string | null; metadata: Meta };

/** The calling device's open run (409 when it ended or belongs to another device). */
export async function ownRun(userId: string, deviceId: string, runId: string): Promise<RunRow> {
  const run = unwrapMaybe(
    await db().from("runs").select("id, started_at, ended_at, metadata").eq("id", runId).eq("user_id", userId).eq("client", EXT_CLIENT).maybeSingle()
  );
  const meta = (run?.metadata as Meta | null) ?? {};
  if (!run || run.ended_at || meta.device_id !== deviceId) throw conflict("This run is no longer live. Start a new one.");
  return { ...run, metadata: meta };
}

export async function patchRunMeta(userId: string, run: RunRow, patch: Meta) {
  run.metadata = { ...run.metadata, ...patch };
  check(await db().from("runs").update({ metadata: run.metadata as Json }).eq("id", run.id).eq("user_id", userId));
}

async function endRun(userId: string, runId: string, summary: string, leaseResult = "ABORTED") {
  const now = new Date().toISOString();
  check(await db().from("ext_leases").update({ completed_at: now, result: leaseResult }).eq("user_id", userId).eq("run_id", runId).is("completed_at", null));
  check(await db().from("runs").update({ ended_at: now, summary }).eq("id", runId).eq("user_id", userId).is("ended_at", null));
}

/**
 * Is Claude working LinkedIn through the MCP right now? Read-only checks of what the MCP
 * writes (section 7.6, check 5):
 *  - platform_state engine_linkedin / engine_linkedin_draft written in the last 30 minutes (the
 *    MCP writes them when it issues or serves an engine), or
 *  - a LinkedIn application changed in the last 15 minutes by anything but the extension.
 * The extension's own rows (metadata.channel 'extension' or engine 'ext@...') and the user's
 * manual applies (applied_by 'user') do not count. retry_at: when the newest activity ages out.
 */
export async function claudeActivity(userId: string): Promise<{ retry_at: string } | null> {
  const now = Date.now();
  let until = 0;
  const engines = unwrap(
    await db()
      .from("platform_state")
      .select("updated_at")
      .eq("user_id", userId)
      .in("platform", ["engine_linkedin", "engine_linkedin_draft"])
      .gte("updated_at", new Date(now - 30 * 60_000).toISOString())
  );
  for (const e of engines) until = Math.max(until, Date.parse(e.updated_at) + 30 * 60_000);
  const apps = unwrap(
    await db()
      .from("applications")
      .select("updated_at, applied_by, metadata")
      .eq("user_id", userId)
      .eq("platform", "linkedin")
      .gte("updated_at", new Date(now - 15 * 60_000).toISOString())
      .limit(200)
  );
  for (const a of apps) {
    const m = (a.metadata as Meta | null) ?? {};
    const ours = m.channel === "extension" || String(m.engine ?? "").startsWith("ext@");
    if (ours || a.applied_by === "user") continue;
    until = Math.max(until, Date.parse(a.updated_at) + 15 * 60_000);
  }
  return until > now ? { retry_at: new Date(until).toISOString() } : null;
}

export async function startSession(dev: DeviceAuth, input: SessionStartRequest): Promise<SessionStartResponse> {
  const { userId, deviceId } = dev;
  if (!linkedinEnabled()) return { type: "disabled", message: DISABLED_MESSAGE };
  if (!(await isSubscribed(userId))) return { type: "not_subscribed", message: "Your Aupply plan is not active." };

  const [profile, prefs] = await Promise.all([getProfile(userId), getPreferences(userId)]);
  const gaps = setupGaps(profile, prefs);
  if (gaps.length) return { type: "setup_needed", gaps };

  // Lazy cleanup for this user: stale runs and expired leases.
  await endStaleRuns(userId);
  await closeExpiredLeases(userId);

  // One loop per account: another device's live run wins; this device's older runs and other
  // devices' runs that stopped beating are ended, so they can never resume alongside this one.
  const now = Date.now();
  for (const r of await openRuns(userId)) {
    const m = (r.metadata as Meta | null) ?? {};
    if (m.device_id !== deviceId && now - lastBeat(r) < LIVE_MS) {
      const other = await liveRun(userId);
      return { type: "busy", reason: "other_device", device_name: other?.device_name ?? null };
    }
  }
  for (const r of await openRuns(userId)) {
    const m = (r.metadata as Meta | null) ?? {};
    await endRun(userId, r.id, m.device_id === deviceId ? "ended: replaced by a new run" : "ended: another device started");
  }

  const claude = await claudeActivity(userId);
  if (claude) return { type: "busy", reason: "claude_active", retry_at: claude.retry_at };

  const block = await activeBlock(userId, input.mode === "draft" ? ["linkedin", "linkedin_guest"] : ["linkedin"]);
  if (block) return { type: "blocked", scope: block.scope, until: block.until, reason: block.reason };
  const guestBlocked = input.mode === "draft_apply" ? await activeBlock(userId, ["linkedin_guest"]) : null;

  const capFull = await linkedinCap(userId, rulesOf(prefs));
  const cap = { cap: capFull.cap, used: capFull.used, left: capFull.left };
  if (cap.left <= 0 && input.mode !== "draft") return { type: "cap_reached", cap };

  const within: PostedWithin = input.posted_within ?? defaultWithin(prefs.max_posting_age_hours);
  const ready = (await linkedinQueue(userId, within)).ready.length;
  const plan = {
    draft: input.mode !== "apply" && !guestBlocked && (input.mode === "draft" || ready < EXT_QUEUE_ENOUGH),
    apply: input.mode !== "draft",
  };
  const at = new Date().toISOString();
  const run = unwrap(
    await db()
      .from("runs")
      .insert({
        user_id: userId,
        client: EXT_CLIENT,
        metadata: {
          channel: "extension", device_id: deviceId, posted_within: within, mode: input.mode, plan,
          ...(input.keywords?.length ? { keywords: input.keywords } : {}), ...(input.target ? { target: input.target } : {}),
          ext_version: dev.version, phase: "starting", last_heartbeat_at: at, slow: false, rate_limited: 0, applies_done: 0,
        } as Json,
      })
      .select("id")
      .single()
  );
  await logEvent(userId, { deviceId, runId: run.id, level: "info", type: "run.started", data: { mode: input.mode, posted_within: within, plan, ready, cap_left: cap.left } });

  // The first action of every run is a tracker read, so the cap knows about applications the
  // user made by hand today (the MCP draft reads the tracker before sweeping for the same reason).
  const issued = await issueLease(userId, { deviceId, runId: run.id, kind: "tracker", notBefore: new Date(), payload: { url: TRACKER_URL } });
  const first = issued.issued
    ? { type: "tracker" as const, lease_id: issued.lease.id, url: TRACKER_URL, not_before: issued.lease.not_before, expires_at: issued.lease.expires_at }
    : { type: "wait" as const, until: issued.expires_at, reason: "lease_busy" as const };
  return { type: "started", run_id: run.id, posted_within: within, plan, cap, first };
}

export async function heartbeat(dev: DeviceAuth, input: { run_id: string; phase: string; hidden?: boolean; job_id?: string }): Promise<HeartbeatResponse> {
  const run = unwrapMaybe(
    await db().from("runs").select("id, ended_at, summary, metadata").eq("id", input.run_id).eq("user_id", dev.userId).eq("client", EXT_CLIENT).maybeSingle()
  );
  const meta = (run?.metadata as Meta | null) ?? {};
  if (!run || meta.device_id !== dev.deviceId) return { ok: true, stop: { reason: "run_not_found" } };
  if (run.ended_at) return { ok: true, stop: { reason: run.summary?.replace(/^ended: /, "") || "run_ended" } };
  if (!linkedinEnabled()) return { ok: true, stop: { reason: "disabled" } };
  const patch = { last_heartbeat_at: new Date().toISOString(), phase: input.phase, hidden: Boolean(input.hidden), ...(input.job_id ? { job_id: input.job_id } : {}) };
  check(await db().from("runs").update({ metadata: { ...meta, ...patch } as Json }).eq("id", run.id).eq("user_id", dev.userId));
  return { ok: true };
}

export async function endSession(dev: DeviceAuth, input: { run_id: string; reason: string }): Promise<SessionEndResponse> {
  const { userId } = dev;
  const run = unwrapMaybe(
    await db().from("runs").select("id, ended_at, metadata").eq("id", input.run_id).eq("user_id", userId).eq("client", EXT_CLIENT).maybeSingle()
  );
  if (!run || ((run.metadata as Meta | null) ?? {}).device_id !== dev.deviceId) throw conflict("This run is not this browser's.");
  const apps = unwrap(
    await db().from("applications").select("id, status, job_title, company_name, job_url").eq("user_id", userId).eq("run_id", run.id).limit(2000)
  );
  const counts: Record<string, number> = {};
  for (const a of apps) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const { trackerCheck } = await import("./apply.js");
  const mismatch = await trackerCheck(userId, run.id, (run.metadata as Meta | null) ?? {});
  if (!run.ended_at) {
    await endRun(userId, run.id, `ended: ${input.reason}`);
    check(await db().from("runs").update({ stats: { linkedin: counts } as Json }).eq("id", run.id).eq("user_id", userId));
    await logEvent(userId, { deviceId: dev.deviceId, runId: run.id, level: "info", type: "run.ended", data: { reason: input.reason, counts } });
  }
  // Provisional answers that went into this run's applications.
  const used: { question: string; answer: string }[] = [];
  const appIds = apps.map((a) => a.id);
  if (appIds.length) {
    const qa = unwrap(await db().from("application_questions").select("answer_id").eq("user_id", userId).in("application_id", appIds.slice(0, 500)).not("answer_id", "is", null));
    const ids = [...new Set(qa.map((q) => q.answer_id as string))];
    if (ids.length) {
      const rows = unwrap(await db().from("answers").select("question, answer").eq("user_id", userId).eq("status", "provisional").in("id", ids));
      used.push(...rows);
    }
  }
  return {
    counts,
    saved_for_you: apps.filter((a) => a.status === "saved").map((a) => ({ id: a.id, title: a.job_title, company: a.company_name, url: a.job_url })),
    provisional_used: used,
    tracker_mismatch: mismatch,
  };
}

/** The tracker reading the run holds and the user's day (for the cap and the end check). */
export async function trackerState(userId: string) {
  return ((await getState(userId, "linkedin"))?.state as Meta | undefined)?.tracker ?? null;
}
