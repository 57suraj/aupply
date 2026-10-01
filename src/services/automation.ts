/**
 * Automation state: the draft queue, engine results, rate-limit backoffs and the
 * LinkedIn daily cap. Shared by the platform tools, queue_jobs and report_results.
 *
 * - The queue is applications with status 'discovered' (metadata.needs_decision marks
 *   jobs waiting on the user's stack decision).
 * - Backoffs live in platform_state.blocked_until per scope (a platform, or a
 *   sub-scope such as linkedin_guest); tools refuse to issue scripts while blocked.
 */

import type { z } from "zod";
import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { check, unwrap, unwrapMaybe } from "../lib/errors.js";
import type { QueueJobsInput, ReportResultsInput } from "../domain/schemas.js";
import { jobUrl, tryCanonicalJobId, wellfoundSlug, type ScriptedPlatform } from "../platforms/ids.js";
import { mapResult } from "../platforms/results.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

async function userTimezone(userId: string): Promise<string> {
  const row = unwrapMaybe(await db().from("profiles").select("timezone").eq("id", userId).maybeSingle());
  return row?.timezone || "Asia/Kolkata";
}

/** Midnight today in `tz`, as a UTC instant. */
export function startOfDay(tz: string, now = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset);
}

// ---------------------------------------------------------------------------
// Platform state and backoffs
// ---------------------------------------------------------------------------

export async function getState(userId: string, scope: string) {
  return unwrapMaybe(
    await db().from("platform_state").select("*").eq("user_id", userId).eq("platform", scope).maybeSingle()
  );
}

/** `current` is the row the caller just read, so the merge does not read it again. */
export async function mergeState(userId: string, scope: string, patch: Meta, current?: Awaited<ReturnType<typeof getState>>) {
  const cur = current === undefined ? await getState(userId, scope) : current;
  check(
    await db()
      .from("platform_state")
      .upsert({ user_id: userId, platform: scope, state: { ...((cur?.state as Meta) ?? {}), ...patch } as Json }, { onConflict: "user_id,platform" })
  );
}

export async function setBlock(userId: string, scope: string, until: Date, reason: string) {
  check(
    await db()
      .from("platform_state")
      .upsert({ user_id: userId, platform: scope, blocked_until: until.toISOString(), block_reason: reason }, { onConflict: "user_id,platform" })
  );
  return { scope, until: until.toISOString(), reason };
}

/** The first active backoff among `scopes`, or null. */
export async function activeBlock(userId: string, scopes: string[]) {
  const rows = unwrap(
    await db()
      .from("platform_state")
      .select("platform, blocked_until, block_reason")
      .eq("user_id", userId)
      .in("platform", scopes)
      .gt("blocked_until", new Date().toISOString())
  );
  const r = rows[0];
  return r ? { scope: r.platform, until: r.blocked_until, reason: r.block_reason } : null;
}

/** The user's open session (start_session), so results are counted in end_session
    even when Claude does not pass run_id. */
export async function currentRunId(userId: string): Promise<string | null> {
  const row = unwrap(
    await db()
      .from("runs")
      .select("id")
      .eq("user_id", userId)
      .is("ended_at", null)
      .gte("started_at", new Date(Date.now() - 12 * 3600_000).toISOString())
      .order("started_at", { ascending: false })
      .limit(1)
  )[0];
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// LinkedIn daily cap
// ---------------------------------------------------------------------------

export const LINKEDIN_CAP = 35;

/** Easy Apply submissions landed today (user's timezone) against the cap. The user's own
    sessions count too; the tracker delta since the first read today covers those. */
export async function linkedinCap(userId: string, rules: Meta) {
  const tz = await userTimezone(userId);
  const since = startOfDay(tz);
  const cap = Math.min(LINKEDIN_CAP, Number(rules.linkedin?.daily_cap) || LINKEDIN_CAP);
  const { count, error } = await db()
    .from("applications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("platform", "linkedin")
    .in("status", ["applied", "unconfirmed"])
    .gte("applied_at", since.toISOString());
  if (error) throw error;
  const ours = count ?? 0;
  const st = ((await getState(userId, "linkedin"))?.state as Meta) ?? {};
  const t = st.tracker?.day === since.toISOString() ? st.tracker : null;
  const tracked = t && t.first != null && t.last != null ? t.last - t.first : 0;
  const used = Math.max(ours, tracked);
  return { cap, used, left: Math.max(0, cap - used), day: since.toISOString() };
}

async function noteTracker(userId: string, count: number | null | undefined) {
  if (count == null) return;
  const since = startOfDay(await userTimezone(userId)).toISOString();
  const st = ((await getState(userId, "linkedin"))?.state as Meta) ?? {};
  const t = st.tracker?.day === since ? st.tracker : { day: since, first: count };
  await mergeState(userId, "linkedin", { tracker: { ...t, last: count } });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const QUEUE_MAX_AGE_HOURS: Record<ScriptedPlatform, number> = { linkedin: 24, naukri: 72, wellfound: 168, indeed: 72 };

export async function queueJobs(userId: string, input: z.infer<typeof QueueJobsInput>) {
  const { platform } = input;
  const invalid: string[] = [];
  const canon = (raw: string) => {
    const id = tryCanonicalJobId(platform, raw);
    if (!id) invalid.push(raw.slice(0, 80));
    return id;
  };

  let stopped = null;
  if (input.stop && /rate_limited/.test(input.stop)) {
    stopped = await setBlock(userId, `${platform}_guest`, new Date(Date.now() + 60 * 60_000), input.stop);
  }
  if (platform === "linkedin") await noteTracker(userId, input.tracker);

  // The user's stack decisions on an earlier ask_user.
  for (const d of input.decisions ?? []) {
    const id = canon(d.id);
    if (!id) continue;
    const row = unwrapMaybe(
      await db().from("applications").select("id, metadata").eq("user_id", userId).eq("platform", platform).eq("external_id", id).maybeSingle()
    );
    if (!row) continue;
    const metadata = { ...((row.metadata as Meta) ?? {}), needs_decision: false } as Json;
    check(
      await db()
        .from("applications")
        .update(d.keep ? { metadata } : { metadata, status: "skipped", status_reason: "stack_declined: the user chose not to apply" })
        .eq("id", row.id)
        .eq("user_id", userId)
    );
  }

  const jobs = new Map<string, (typeof input.jobs)[number]>();
  for (const j of input.jobs) { const id = canon(j.id); if (id) jobs.set(id, j); }
  const skips = new Map<string, (typeof input.skipped)[number]>();
  for (const j of input.skipped) { const id = canon(j.id); if (id && !jobs.has(id)) skips.set(id, j); }

  const all = [...jobs.keys(), ...skips.keys()];
  const known = new Set<string>();
  for (let i = 0; i < all.length; i += 200) {
    const rows = unwrap(
      await db().from("applications").select("external_id").eq("user_id", userId).eq("platform", platform).in("external_id", all.slice(i, i + 200))
    );
    rows.forEach((r) => r.external_id && known.add(r.external_id));
  }

  const prefs = unwrapMaybe(await db().from("preferences").select("max_years_required").eq("user_id", userId).maybeSingle());
  const maxYears = prefs?.max_years_required ?? null;
  const score = (j: (typeof input.jobs)[number]) => {
    let s = 50;
    if (j.w === "1h") s += 30;
    if (j.agg) s -= 40;
    if (j.yu) s -= 5;
    if (j.minY != null && maxYears != null && j.minY <= maxYears) s += 10;
    if (j.sm?.length) s -= 10;
    return Math.max(0, Math.min(100, s));
  };

  const base = { user_id: userId, platform, source: input.source, run_id: input.run_id ?? (await currentRunId(userId)) };
  const inserts = [
    ...[...jobs.entries()].filter(([id]) => !known.has(id)).map(([id, j]) => {
      const slug = platform === "wellfound" ? j.s ?? wellfoundSlug(j.id) : null;
      const needsDecision = Boolean(j.sm?.length);
      return {
        ...base,
        external_id: id,
        job_url: jobUrl(platform, id, slug),
        company_name: j.co || "(unknown)",
        job_title: j.t || "(unknown)",
        location: j.loc ?? null,
        salary_text: j.sal ?? null,
        experience_min_years: j.minY ?? j.ye ?? null,
        status: "discovered",
        match_score: score(j),
        metadata: { w: j.w, agg: j.agg, lvl: j.lvl, pay: j.pay, sm: j.sm, yu: j.yu, slug, needs_decision: needsDecision } as Json,
      };
    }),
    ...[...skips.entries()].filter(([id]) => !known.has(id)).map(([id, j]) => ({
      ...base,
      external_id: id,
      job_url: jobUrl(platform, id, platform === "wellfound" ? wellfoundSlug(j.id) : null),
      company_name: j.co || "(unknown)",
      job_title: j.t || "(unknown)",
      status: "skipped",
      status_reason: `draft: ${j.r}`,
      metadata: { skip_code: j.r } as Json,
    })),
  ];
  if (inserts.length) {
    check(await db().from("applications").upsert(inserts, { onConflict: "user_id,platform,external_id", ignoreDuplicates: true }));
  }

  const queued = inserts.filter((r) => r.status === "discovered");
  const ask = queued.filter((r) => (r.metadata as Meta).needs_decision);
  return {
    queued: queued.filter((r) => !(r.metadata as Meta).needs_decision).map((r) => [r.external_id, r.job_title.slice(0, 60), r.company_name.slice(0, 40)]),
    ...(ask.length
      ? { ask_user: ask.map((r) => ({ id: r.external_id, title: r.job_title, company: r.company_name, wants: (r.metadata as Meta).sm })) }
      : {}),
    counts: { queued: queued.length - ask.length, ask_user: ask.length, skipped: inserts.length - queued.length, already_known: known.size, invalid: invalid.length },
    ...(invalid.length ? { invalid } : {}),
    ...(stopped ? { stopped } : {}),
    next: ask.length
      ? `Show the user the ask_user jobs in one message (each wants a technology they do not list) and pass their answers to queue_jobs as decisions. Meanwhile apply to the rest: ${platform}_apply with from_queue.`
      : `Apply: ${platform}_apply with from_queue.`,
  };
}

/** The drafted queue for a platform, best first. */
export async function queuedJobs(userId: string, platform: ScriptedPlatform, limit: number) {
  const since = new Date(Date.now() - QUEUE_MAX_AGE_HOURS[platform] * 3600_000).toISOString();
  return unwrap(
    await db()
      .from("applications")
      .select("external_id, company_name, job_title, job_url, metadata")
      .eq("user_id", userId)
      .eq("platform", platform)
      .eq("status", "discovered")
      .eq("metadata->>needs_decision", "false")
      .gte("created_at", since)
      .order("match_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(limit)
  );
}

/** Rows for explicit job ids, to learn company/URL and drop jobs already handled. */
export async function jobsById(userId: string, platform: ScriptedPlatform, ids: string[]) {
  if (!ids.length) return [];
  return unwrap(
    await db()
      .from("applications")
      .select("external_id, status, company_name, job_title, job_url, metadata")
      .eq("user_id", userId)
      .eq("platform", platform)
      .in("external_id", ids)
  );
}

/** Lowercased companies this user already applied to on the platform (Wellfound dedup). */
export async function appliedCompanies(userId: string, platform: ScriptedPlatform) {
  const rows = unwrap(
    await db()
      .from("applications")
      .select("company_name")
      .eq("user_id", userId)
      .eq("platform", platform)
      .in("status", ["applied", "unconfirmed", "parked"])
      .limit(2000)
  );
  return [...new Set(rows.map((r) => r.company_name.toLowerCase()).filter((c) => c && c !== "(unknown)"))];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export async function reportResults(userId: string, input: z.infer<typeof ReportResultsInput>) {
  const { platform } = input;
  const runId = input.run_id ?? (await currentRunId(userId));
  const items = input.results
    .map((rec) => ({ rec, id: rec.id ? tryCanonicalJobId(platform, rec.id) : null }))
    .filter((x): x is { rec: typeof x.rec; id: string } => Boolean(x.id));
  const ids = [...new Set(items.map((x) => x.id))];
  const rows = new Map(
    (ids.length
      ? unwrap(await db().from("applications").select("id, external_id, status, metadata").eq("user_id", userId).eq("platform", platform).in("external_id", ids))
      : []
    ).map((r) => [r.external_id as string, r])
  );

  const recorded: unknown[] = [];
  const retry: string[] = [], driveAgain: string[] = [];
  const ask: { id: string; questions: string[] }[] = [];
  const handoff: Record<string, unknown>[] = [];
  let stopped: { scope: string; until: string; reason: string } | null = null;
  let streak: number | null = null;

  for (const { rec, id } of items) {
    const row = rows.get(id);
    const meta = ((row?.metadata as Meta) ?? {}) as Meta;
    const seen: string[] = meta.attempt_ids ?? [];
    if (rec.a && seen.includes(rec.a)) continue; // already recorded (a repeated poll)
    const fails = meta.fails ?? 0;
    const o = mapResult(platform, rec, fails);
    const metadata = {
      ...meta,
      last_result: rec.r,
      attempt_ids: [...seen, rec.a].filter(Boolean).slice(-10),
      fails: o.retryable ? fails + 1 : fails,
      ...(rec.need ? { need: rec.need } : {}),
      ...(rec.hid ? { hid: 1 } : {}),
      ...(input.engine ? { engine: input.engine } : {}),
    } as Json;
    const status = o.status ?? (row?.status as string | undefined) ?? "discovered";
    const values = {
      metadata,
      ...(o.status ? { status: o.status, status_reason: o.reason ?? null } : {}),
      ...(runId ? { run_id: runId } : {}),
    };
    const saved = row
      ? unwrap(await db().from("applications").update(values).eq("id", row.id).eq("user_id", userId).select("id, external_id, status, metadata").single())
      : unwrap(
          await db()
            .from("applications")
            .insert({
              ...values, user_id: userId, platform, external_id: id, status,
              company_name: rec.co || "(unknown)", job_title: rec.t || "(unknown)", job_url: jobUrl(platform, id), source: "aupply",
            })
            .select("id, external_id, status, metadata")
            .single()
        );
    rows.set(id, saved);
    recorded.push([id, rec.r, saved.status]);

    if (rec.qa?.length && ["applied", "unconfirmed", "parked"].includes(saved.status)) {
      check(await db().from("application_questions").insert(rec.qa.map(([question, answer]) => ({ user_id: userId, application_id: saved.id, question, answer }))));
    }

    if (o.next === "retry") retry.push(id);
    else if (o.next === "ask_user") ask.push({ id, questions: rec.need ?? [] });
    else if (o.next === "handoff") handoff.push({ id, r: rec.r, need: rec.need, ...(rec.rect ? { rect: rec.rect, iw: rec.iw } : {}) });
    else if (o.next === "drive_again") driveAgain.push(id);

    if (o.block) {
      const until = o.block.endOfDay
        ? new Date(startOfDay(await userTimezone(userId)).getTime() + 24 * 3600_000)
        : new Date(Date.now() + (o.block.minutes ?? 60) * 60_000);
      stopped = await setBlock(userId, o.block.scope, until, o.block.reason);
    }
    // Wellfound: two NO_MODAL failures in a row (each after its retry) is a session
    // throttle, not a dead listing.
    if (platform === "wellfound") {
      if (rec.r === "NO_MODAL" && o.status === "failed") streak = (streak ?? ((((await getState(userId, "wellfound"))?.state as Meta) ?? {}).nomodal_fails ?? 0)) + 1;
      else if (["SENT", "UNCONF", "ALREADY"].includes(rec.r)) streak = 0;
    }
  }

  if (streak !== null) {
    await mergeState(userId, "wellfound", { nomodal_fails: streak });
    if (streak >= 2) stopped = await setBlock(userId, "wellfound", new Date(Date.now() + 6 * 3600_000), "Wellfound throttle: NO_MODAL twice in a row");
  }

  let trackerCheck = null;
  if (platform === "linkedin" && input.tracker) {
    const { before, after } = input.tracker;
    await noteTracker(userId, (before as number | null | undefined) ?? null);
    await noteTracker(userId, (after as number | null | undefined) ?? null);
    const st = ((await getState(userId, "linkedin"))?.state as Meta) ?? {};
    if (before != null && after != null && st.queue_started_at) {
      const { count } = await db()
        .from("applications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("platform", "linkedin")
        .in("status", ["applied", "unconfirmed"])
        .gte("applied_at", st.queue_started_at);
      trackerCheck = { moved: (after as number) - (before as number), recorded: count ?? 0 };
    }
  }

  const next: string[] = [];
  if (stopped) next.push(`Stop ${stopped.scope} until ${stopped.until} (${stopped.reason}). Its tools refuse scripts until then.`);
  if (retry.length) next.push(`Retry once: ${platform}_apply with jobs ${JSON.stringify(retry)}.`);
  if (ask.length) next.push("For the questions in ask_user: call resolve_answers first, ask the user (in one message) only what stays unknown or protected, save their answers with save_answer (confirmed_by_user), then re-run apply for those jobs with `answers`.");
  if (handoff.length) next.push("Handoffs need a real click: re-run those jobs one at a time with keep_open, do the click the code names (NEEDS_CLICK: click the suggestion under the field; FOLLOW_STUCK: untick Follow; NEEDS_DROPDOWN: open the box, type, click the option), then call __aupply.resume('<id>') or drive('<id>').");
  if (driveAgain.length) next.push(`Call __aupply.drive() again for: ${JSON.stringify(driveAgain)} (in the smartapply tab after NAVIGATED).`);
  if (trackerCheck && trackerCheck.moved < trackerCheck.recorded) {
    next.push(`The tracker moved ${trackerCheck.moved} for ${trackerCheck.recorded} submissions: open the tracker and check which UNCONFIRMED jobs are missing.`);
  }

  const cap = platform === "linkedin"
    ? await linkedinCap(userId, ((unwrapMaybe(await db().from("preferences").select("rules").eq("user_id", userId).maybeSingle())?.rules as Meta) ?? {}))
    : null;
  return {
    recorded,
    ...(ask.length ? { ask_user: ask } : {}),
    ...(handoff.length ? { handoff } : {}),
    ...(stopped ? { stopped } : {}),
    ...(trackerCheck ? { tracker: trackerCheck } : {}),
    ...(cap ? { cap_left: cap.left } : {}),
    next: next.length ? next : [input.tracker?.after != null ? "This queue is done: nothing left to do for it." : "Continue polling; report the next batch."],
  };
}

export async function markQueueStarted(userId: string, platform: ScriptedPlatform) {
  await mergeState(userId, platform, { queue_started_at: new Date().toISOString() });
}
