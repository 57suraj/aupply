/**
 * The apply pipeline (section 9): the server hands the extension one job at a time under a
 * lease, answers its form pages (formAnswers.ts), records each result with the MCP's own result
 * map, retry, cap and backoff rules, and reads LinkedIn's Applied count along the way.
 *
 * apply/next, in order: the device's open lease (resume after a restart), a LinkedIn backoff,
 * Claude at work, the shared daily cap, a tracker read when one is due, then the best queued
 * job (or an UNCONFIRMED one of this run to verify), paced 30 to 45 seconds after the last one.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { check, unwrap, unwrapMaybe } from "../../lib/errors.js";
import { rulesOf } from "../../platforms/config.js";
import { strongMatch, type DraftFacts } from "../../platforms/fit.js";
import { mapResult } from "../../platforms/results.js";
import { activeBlock, getState, linkedinCap, mergeState, setBlock, startOfDay } from "../../services/automation.js";
import { getPreferences, getProfile } from "../../services/candidate.js";
import type { DeviceAuth } from "../auth/requireDevice.js";
import type { ApplyNextResponse, ApplyResult, ApplyResultResponse, Cap, JobOrder, TrackerOrder } from "../contract.js";
import { DISABLED_MESSAGE, linkedinEnabled } from "../server/http.js";
import { logEvent } from "./events.js";
import { addLeaseDetail, closeExpiredLeases, completeLease, getLease, issueLease, lastCompleted, type LeaseRow } from "./leases.js";
import { extAt, linkedinQueue, metaOf } from "./queue.js";
import { dismissedAmong, openAmong } from "./questions.js";
import { claudeActivity, ownRun, patchRunMeta, TRACKER_URL, type RunRow } from "./sessions.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

/** A backoff that ends within this long is waited out; a longer one ends the run. */
const WAIT_LIMIT_MS = 2 * 3600_000;
/** The extension's floor between jobs is 30s (Chrome alarms fire no sooner); slower is always allowed. */
const GAP_MIN_MS = 30_000;
const GAP_MAX_MS = 45_000;
const PAGE_WAIT_MS = 6000;
const PAGE_WAIT_SLOW_MS = 8000;
/** LinkedIn's tracker count is read again after this many apply leases in a run. */
const TRACKER_EVERY = 10;
const RETRY_AFTER_MS = 15 * 60_000;
const RATE_PAUSE_MS = 5 * 60_000;
/** src/services/automation.ts' text for the same case (not exported there). */
const SAVED_REASON = "not Easy Apply; a strong match, saved on the dashboard for you to apply yourself";
/** Handoffs the extension tried a trusted click for: one more attempt later, then failed (section 11.6). */
const HANDOFF_RETRY = new Set(["NEEDS_CLICK", "FOLLOW_STUCK"]);

const jitter = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));

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

// ---------------------------------------------------------------------------
// apply/next
// ---------------------------------------------------------------------------

function trackerOrder(l: LeaseRow): TrackerOrder {
  return { type: "tracker", lease_id: l.id, url: TRACKER_URL, not_before: l.not_before, expires_at: l.expires_at };
}

function jobOrder(l: LeaseRow): JobOrder {
  const p = (l.payload as Meta) ?? {};
  return {
    type: "job", lease_id: l.id, not_before: l.not_before, expires_at: l.expires_at,
    job: p.job, page_wait_ms: p.page_wait_ms ?? PAGE_WAIT_MS, country: p.country ?? null, attempt: p.attempt ?? 1, verify: Boolean(p.verify),
  };
}

async function issueTracker(dev: DeviceAuth, run: RunRow): Promise<ApplyNextResponse> {
  const issued = await issueLease(dev.userId, { deviceId: dev.deviceId, runId: run.id, kind: "tracker", notBefore: new Date(), payload: { url: TRACKER_URL } });
  return issued.issued ? trackerOrder(issued.lease) : { type: "wait", until: issued.expires_at, reason: "lease_busy" };
}

export async function applyNext(dev: DeviceAuth, input: { run_id: string }): Promise<ApplyNextResponse> {
  const { userId, deviceId } = dev;
  if (!linkedinEnabled()) return { type: "disabled", message: DISABLED_MESSAGE };
  const run = await ownRun(userId, deviceId, input.run_id);

  // The device asks again for work it already holds (its service worker restarted): the same lease.
  const open = unwrapMaybe(
    await db()
      .from("ext_leases")
      .select("*")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .eq("run_id", run.id)
      .in("kind", ["apply", "tracker"])
      .is("completed_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  if (open) return open.kind === "tracker" ? trackerOrder(open) : jobOrder(open);
  // Settle leases that ran out first (an expired job counts as ERR and waits for its retry), so
  // the pick below never hands the same job straight back.
  await closeExpiredLeases(userId);

  const block = await activeBlock(userId, ["linkedin"]);
  if (block?.until) {
    return Date.parse(block.until) - Date.now() <= WAIT_LIMIT_MS
      ? { type: "wait", until: block.until, reason: "blocked" }
      : { type: "done", reason: "blocked", until: block.until };
  }
  const claude = await claudeActivity(userId);
  if (claude) return { type: "wait", until: claude.retry_at, reason: "claude_active" };

  const [prefs, profile] = await Promise.all([getPreferences(userId), getProfile(userId)]);
  const cap = await linkedinCap(userId, rulesOf(prefs));
  const m = run.metadata;
  const sinceTracker = Number(m.applies_done ?? 0) - Number(m.tracker_at_applies ?? 0);
  if (cap.left <= 0) {
    // One more tracker read when jobs were sent since the last one, so the end check is fair.
    return sinceTracker > 0 ? issueTracker(dev, run) : { type: "done", reason: "cap" };
  }
  if (m.tracker_last == null || sinceTracker >= TRACKER_EVERY) return issueTracker(dev, run);

  // The best ready job; else an UNCONFIRMED job of this run not yet verified.
  const within = (m.posted_within ?? "24h") as "1h" | "24h" | "1w";
  const { ready, waiting } = await linkedinQueue(userId, within, 50);
  type Pick = { id: string; external_id: string; job_title: string; company_name: string; job_url: string | null; metadata: unknown };
  let pick = null as Pick | null;
  let verify = false;
  if (ready.length) {
    pick = unwrapMaybe(
      await db()
        .from("applications")
        .select("id, external_id, job_title, company_name, job_url, metadata")
        .eq("user_id", userId)
        .eq("platform", "linkedin")
        .eq("external_id", ready[0].external_id as string)
        .maybeSingle()
    ) as unknown as Pick | null;
  } else {
    const unconfirmed = unwrap(
      await db()
        .from("applications")
        .select("id, external_id, job_title, company_name, job_url, metadata")
        .eq("user_id", userId)
        .eq("platform", "linkedin")
        .eq("run_id", run.id)
        .eq("status", "unconfirmed")
        .limit(20)
    );
    pick = (unconfirmed.find((a) => !metaOf(a).verified) as unknown as Pick | undefined) ?? null;
    verify = Boolean(pick);
  }
  if (!pick) return sinceTracker > 0 ? issueTracker(dev, run) : { type: "done", reason: "queue_empty", waiting_on_you: waiting.length };

  const last = await lastCompleted(userId, ["apply"]);
  const notBefore = new Date(Math.max(Date.now(), last?.completed_at ? Date.parse(last.completed_at) + jitter(GAP_MIN_MS, GAP_MAX_MS) : 0));
  const meta = metaOf(pick);
  const payload = {
    job: {
      id: pick.external_id,
      url: pick.job_url ?? `https://www.linkedin.com/jobs/view/${pick.external_id}/`,
      company: pick.company_name === "(unknown)" ? "" : pick.company_name,
      title: pick.job_title === "(unknown)" ? "" : pick.job_title,
    },
    page_wait_ms: m.slow ? PAGE_WAIT_SLOW_MS : PAGE_WAIT_MS,
    country: profile.location_country,
    attempt: Number(meta.fails ?? 0) + 1,
    verify,
  };
  const issued = await issueLease(userId, { deviceId, runId: run.id, kind: "apply", applicationId: pick.id, externalId: pick.external_id, payload, notBefore });
  if (!issued.issued) return { type: "wait", until: issued.expires_at, reason: "lease_busy" };
  await patchRunMeta(userId, run, { phase: "applying" });
  return jobOrder(issued.lease);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

async function fitUser(userId: string) {
  const [prefs, profile] = await Promise.all([getPreferences(userId), getProfile(userId)]);
  return { roles: prefs.desired_roles.length ? prefs.desired_roles : ([profile.current_title].filter(Boolean) as string[]), years: profile.years_experience };
}

/** The Q&A the server decided for this lease, one entry per question, for application_questions. */
function qaOf(lease: LeaseRow) {
  const pages = (((lease.detail as Meta) ?? {}).pages ?? {}) as Record<string, { qa?: { question: string; answer: string; source: string; answer_id: string | null; field_type: string }[] }>;
  const seen = new Map<string, { question: string; answer: string; source: string; answer_id: string | null; field_type: string }>();
  for (const k of Object.keys(pages).sort((a, b) => Number(a) - Number(b))) for (const e of pages[k].qa ?? []) seen.set(e.question, e);
  return [...seen.values()];
}

/** Record one apply lease's result (section 9.6). Shared by apply/result and expired leases. */
async function settle(userId: string, lease: LeaseRow, res: ApplyResult, version: string | null): Promise<ApplyResultResponse> {
  const run = unwrapMaybe(await db().from("runs").select("id, started_at, ended_at, metadata").eq("id", lease.run_id).eq("user_id", userId).maybeSingle());
  const runMeta = ((run?.metadata as Meta | null) ?? {}) as Meta;
  const row = lease.application_id
    ? unwrapMaybe(
        await db()
          .from("applications")
          .select("id, external_id, status, metadata, job_title, experience_min_years, applied_by")
          .eq("id", lease.application_id)
          .eq("user_id", userId)
          .maybeSingle()
      )
    : null;
  const meta = ((row?.metadata as Meta | null) ?? {}) as Meta;
  const fails = Number(meta.fails ?? 0);
  const verify = Boolean((lease.payload as Meta)?.verify);
  const rl = res.r === "RATE_LIMITED" ? Number(runMeta.rate_limited ?? 0) + 1 : Number(runMeta.rate_limited ?? 0);

  let o = mapResult("linkedin", { r: res.r, n: rl, need: res.need }, fails);
  let next: ApplyResultResponse["next"] = { type: "continue" };
  const patch: Meta = {};
  let newFails = fails;
  const runPatch: Meta = { applies_done: Number(runMeta.applies_done ?? 0) + 1, rate_limited: rl };

  switch (res.r) {
    case "NO_EASY_APPLY":
      // Not Easy Apply (the company-site Apply was on the page) but a strong match: saved for the user.
      if (row && strongMatch({ title: row.job_title, minYears: row.experience_min_years, facts: meta as DraftFacts }, await fitUser(userId))) {
        o = { ...o, status: "saved", reason: SAVED_REASON };
      }
      break;
    case "NEEDS_INPUT": {
      // The job leaves the ready queue until its questions are answered; a question the user
      // dismissed skips it instead.
      const asked = [...new Set([...(res.question_ids ?? []), ...Object.values(((lease.detail as Meta) ?? {}).pages ?? {}).flatMap((p: any) => p.questions ?? [])])];
      const dismissed = await dismissedAmong(userId, asked);
      if (dismissed.length) o = { status: "skipped", reason: `needs your answer: ${dismissed[0].question}`.slice(0, 500), next: "continue" };
      else {
        const open = await openAmong(userId, asked);
        if (open.length) patch.needs_input = open;
        else {
          // Nothing left to ask (answered meanwhile): try again later like any other failure.
          patch.retry_after = new Date(Date.now() + RETRY_AFTER_MS).toISOString();
        }
      }
      break;
    }
    case "RATE_LIMITED":
      if (rl < 2) {
        // First "Rate Limited" page in this run: a 5 minute pause, then 8 second page waits.
        await setBlock(userId, "linkedin", new Date(Date.now() + RATE_PAUSE_MS), "LinkedIn showed its Rate Limited page: a 5 minute pause");
        runPatch.slow = true;
        patch.retry_after = new Date(Date.now() + RATE_PAUSE_MS).toISOString();
      } else next = { type: "stop", reason: "rate_limited" };
      break;
    case "DAILY_LIMIT":
      next = { type: "stop", reason: "cap" };
      break;
    case "CHECKPOINT":
    case "LOGGED_OUT":
      next = { type: "stop", reason: res.r.toLowerCase() };
      break;
    case "USER_NAVIGATED":
      next = { type: "pause", reason: "user_navigated" };
      break;
  }
  if (HANDOFF_RETRY.has(res.r)) {
    o = fails < 1 ? { status: null, next: "retry", retryable: true } : { status: "failed", reason: `${res.r} twice`, next: "continue", retryable: true };
  }
  if (o.retryable) {
    newFails = fails + 1;
    // A retry goes to the back of the queue, never straight away.
    if (!o.status) patch.retry_after = new Date(Date.now() + RETRY_AFTER_MS).toISOString();
  }
  if (o.block) {
    const until = o.block.endOfDay
      ? new Date(startOfDay(await userTimezone(userId)).getTime() + 24 * 3600_000)
      : new Date(Date.now() + (o.block.minutes ?? 60) * 60_000);
    await setBlock(userId, o.block.scope, until, o.block.reason);
  }

  let status = row?.status ?? null;
  if (row) {
    const metadata: Meta = {
      ...meta,
      ...patch,
      last_result: res.r,
      attempt_ids: [...((meta.attempt_ids as string[] | undefined) ?? []), lease.id].slice(-10),
      fails: newFails,
      ...(res.need ? { need: res.need } : {}),
      ...(res.errs?.length ? { errs: res.errs } : {}),
      ...(res.e ? { e: res.e } : {}),
      ...(res.hid ? { hid: 1 } : {}),
      // The engine that ran it: this extension's version (an expired lease has none: the run's).
      engine: `ext@${version ?? runMeta.ext_version ?? "unknown"}`,
      ...(verify ? { verified: true } : {}),
      ...extAt(),
    };
    if (o.status) {
      delete metadata.retry_after;
      delete metadata.needs_input;
    }
    const ours = (o.status === "applied" || o.status === "unconfirmed") && !/^ALREADY/.test(res.r);
    const kept = unwrap(
      await db()
        .from("applications")
        .update({
          metadata: metadata as Json,
          ...(o.status ? { status: o.status, status_reason: o.reason ?? null } : {}),
          ...(ours ? { applied_by: "aupply" } : {}),
          run_id: lease.run_id,
        })
        .eq("id", row.id)
        .eq("user_id", userId)
        .select("id, status")
        .single()
    );
    status = kept.status;
    if (o.status && ["applied", "unconfirmed", "parked"].includes(kept.status) && !/^ALREADY/.test(res.r)) {
      const qa = qaOf(lease);
      if (qa.length) {
        check(
          await db().from("application_questions").insert(
            qa.map((q) => ({
              user_id: userId, application_id: kept.id, question: q.question.slice(0, 2000), answer: q.answer.slice(0, 20000),
              answer_id: q.answer_id, field_type: q.field_type, metadata: { origin: "extension", source: q.source } as Json,
            }))
          )
        );
      }
    }
  }
  if (run && !run.ended_at) {
    check(await db().from("runs").update({ metadata: { ...runMeta, ...runPatch } as Json }).eq("id", run.id).eq("user_id", userId));
  }
  const cap = await linkedinCap(userId, rulesOf(await getPreferences(userId)));
  if (next.type !== "continue" || ["ERR", "STALL", "NO_MODAL", "TITLE_MISMATCH", "NOT_LOADED"].includes(res.r)) {
    await logEvent(userId, { deviceId: lease.device_id, runId: lease.run_id, level: next.type === "continue" ? "info" : "warn", type: "apply.result", data: { r: res.r, e: res.e, errs: res.errs, trace: res.trace?.slice(-12), status, next: next.type } });
  }
  return { status, reason: o.reason ?? null, cap: { left: cap.left }, next };
}

export async function applyResult(dev: DeviceAuth, input: { lease_id: string; result: ApplyResult }): Promise<ApplyResultResponse> {
  const { userId } = dev;
  const lease = await getLease(userId, input.lease_id, dev.deviceId, "apply");
  const done = await completeLease(userId, lease, input.result.r, { result: input.result });
  if (!done.first) {
    // The same result again (a retry after a lost answer): the stored outcome, never processed twice.
    const stored = ((done.lease.detail as Meta) ?? {}).outcome as ApplyResultResponse | undefined;
    if (stored) return stored;
    const cap = await linkedinCap(userId, rulesOf(await getPreferences(userId)));
    return { status: null, reason: null, cap: { left: cap.left }, next: { type: "continue" } };
  }
  const outcome = await settle(userId, done.lease, input.result, dev.version);
  await addLeaseDetail(userId, done.lease, { outcome });
  return outcome;
}

/** An apply lease that expired (the extension vanished mid-job) counts as ERR for its job. */
export async function settleExpiredApplies(leases: LeaseRow[]): Promise<void> {
  for (const lease of leases) {
    try {
      await settle(lease.user_id, lease, { r: "ERR", e: "lease_expired" }, null);
    } catch (err) {
      console.error("[ext] settling an expired lease failed", err instanceof Error ? err.message : err);
    }
  }
}
