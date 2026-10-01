/**
 * Sessions: start_session opens a run and returns everything Claude needs before
 * applying (what waits on the user, what to reconcile, each
 * platform's state); end_session closes it with counts computed from the database,
 * not from Claude's tally, plus the provisional answers used. A session reports what it
 * logged, not how applications convert.
 */

import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { notFound, unwrap, unwrapMaybe } from "../lib/errors.js";
import { isScripted, SCRIPTED_PLATFORMS, type ScriptedPlatform } from "../platforms/ids.js";
import { rulesOf } from "../platforms/config.js";
import { listPendingActions } from "./applications.js";
import { getPreferences, getProfile, setupGaps } from "./candidate.js";
import { getState, linkedinCap, QUEUE_MAX_AGE_HOURS, queuedJobs, startOfDay } from "./automation.js";
import { defaultWithin } from "../platforms/config.js";
import type { PostedWithin } from "../domain/schemas.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;
/** Queued jobs that are enough to apply from: a chat does not re-draft (the draft engine is code to load and
    requests to the platform) until the queue runs low. */
const QUEUE_ENOUGH: Record<ScriptedPlatform, number> = { linkedin: 10, naukri: 3, wellfound: 3, indeed: 3 };

const HOW_TO_CONFIRM: Record<string, string> = {
  indeed: "The user submits the CAPTCHA themselves: ask which of these they sent, then log_application status applied for those.",
  linkedin: "Re-run linkedin_apply with these ids: jobs that landed report ALREADY_APPLIED and are marked applied; the rest apply again.",
  wellfound: "Re-run wellfound_apply with these jobs: landed ones report ALREADY.",
  naukri: "Re-run naukri_apply with these jobs: landed ones report ALREADY.",
};

export async function startSession(userId: string, input: { client?: string; platforms?: string[]; posted_within?: PostedWithin }) {
  const [prefs, profile] = await Promise.all([getPreferences(userId), getProfile(userId)]);
  const setup = setupGaps(profile, prefs);
  const wanted = (input.platforms?.length ? input.platforms : prefs.platforms.length ? prefs.platforms : [...SCRIPTED_PLATFORMS]).map((p) => p.toLowerCase());
  const platforms = [...new Set(wanted.filter(isScripted))];
  // How recent the LinkedIn jobs are, for the whole session: the draft searches and the queue follow it.
  const within = input.posted_within ?? defaultWithin(prefs.max_posting_age_hours);

  const live = unwrap(
    await db()
      .from("runs")
      .select("id, started_at, client")
      .eq("user_id", userId)
      .is("ended_at", null)
      .gte("started_at", new Date(Date.now() - 2 * 3600_000).toISOString())
      .order("started_at", { ascending: false })
      .limit(1)
  )[0];
  const run = unwrap(
    await db().from("runs").insert({ user_id: userId, client: input.client ?? null, metadata: { platforms, linkedin_within: within } as Json }).select("id").single()
  );

  const tz = profile.timezone || "Asia/Kolkata";
  const today = startOfDay(tz).toISOString();
  const [pending, provisional, toReconcile, blocks] = await Promise.all([
    listPendingActions(userId),
    db().from("answers").select("key, question, answer").eq("user_id", userId).eq("status", "provisional").order("updated_at", { ascending: false }).limit(20),
    db()
      .from("applications")
      .select("platform, external_id, job_title, company_name, status")
      .eq("user_id", userId)
      .in("status", ["parked", "unconfirmed"])
      .gte("updated_at", new Date(Date.now() - 14 * 86400_000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(100),
    db().from("platform_state").select("platform, blocked_until, block_reason").eq("user_id", userId).gt("blocked_until", new Date().toISOString()),
  ]);

  const state: Record<string, Meta> = {};
  for (const p of platforms) {
    // The same rows linkedin_apply's from_queue takes.
    const s: Meta = { queued: (await queuedJobs(userId, p, 500, within)).length };
    if (p === "linkedin") s.posted_within = within;
    // Drafted jobs that want a technology the user does not list wait for their decision.
    // Only the queue_jobs call that drafted them asks, so a chat that ended before the
    // user answered left them stuck (1 Oct: 14 LinkedIn jobs nobody was asked about again).
    const undecided = unwrap(
      await db()
        .from("applications")
        .select("external_id, job_title, company_name, metadata")
        .eq("user_id", userId)
        .eq("platform", p)
        .eq("status", "discovered")
        .eq("metadata->>needs_decision", "true")
        .gte("created_at", new Date(Date.now() - QUEUE_MAX_AGE_HOURS[p] * 3600_000).toISOString())
        .order("match_score", { ascending: false, nullsFirst: false })
        .limit(30)
    );
    if (undecided.length) {
      s.ask_user = undecided.map((r) => ({ id: r.external_id, title: r.job_title.slice(0, 60), company: r.company_name.slice(0, 40), wants: (r.metadata as Meta)?.sm ?? [] }));
    }
    const block = unwrap(blocks).find((b) => b.platform === p || b.platform === `${p}_guest`);
    if (block) s.blocked = { scope: block.platform, until: block.blocked_until, reason: block.block_reason };
    if (p === "linkedin") {
      const cap = await linkedinCap(userId, rulesOf(prefs));
      s.used_today = cap.used;
      s.cap_left = cap.left;
    }
    if (p === "naukri") {
      const refresh = (((await getState(userId, "naukri"))?.state as Meta) ?? {}).refresh ?? null;
      s.refresh_due = !refresh || refresh.at < today;
      if (refresh) s.last_refresh = { chip: refresh.chip, action: refresh.action, at: refresh.at };
    }
    state[p] = s;
  }

  const groups = new Map<string, { platform: string; status: string; jobs: string[][] }>();
  for (const r of unwrap(toReconcile)) {
    const k = `${r.platform}:${r.status}`;
    if (!groups.has(k)) groups.set(k, { platform: r.platform, status: r.status, jobs: [] });
    groups.get(k)!.jobs.push([r.external_id ?? "", r.job_title.slice(0, 60), r.company_name.slice(0, 40)]);
  }

  const next = [
    ...(setup.length
      ? ["Profile incomplete (setup_needed): read get_resume, propose values for those fields, ask the user about the rest, and save what they confirm with update_profile before drafting."]
      : []),
    ...(pending.length ? ["Raise pending_actions with the user first: anything waiting on them outranks new applications."] : []),
    ...(groups.size ? ["Reconcile parked and unconfirmed jobs as each group's `how` says."] : []),
    ...(Object.values(state).some((s) => s.ask_user)
      ? ["Some drafted jobs want a technology the user does not list (platforms.<platform>.ask_user): ask the user in one message whether to apply to each, then pass their answers to queue_jobs (platform, decisions) so the kept ones join the queue."]
      : []),
    ...(state.naukri?.refresh_due ? ["Run naukri_refresh_profile once today."] : []),
    ...platforms.map((p) =>
      state[p].blocked
        ? `${p}: blocked, leave it.`
        : state[p].queued >= QUEUE_ENOUGH[p]
          ? `${p}: ${state[p].queued} jobs are queued, so go straight to ${p}_apply with from_queue; draft again only when the queue runs low or the user asks.`
          : `${p}: ${p}_draft, queue_jobs, then ${p}_apply with from_queue.`
    ),
    "report_results as you go. End with end_session.",
  ];
  return {
    run_id: run.id,
    ...(live
      ? { another_run_live: { run_id: live.id, started_at: live.started_at, note: "Another session started under two hours ago and never ended. If it may still be running in this browser, leave LinkedIn to it and re-read the Naukri chip before toggling." } }
      : {}),
    ...(setup.length ? { setup_needed: setup } : {}),
    pending_actions: pending,
    platforms: state,
    reconcile: [...groups.values()].map((g) => ({ ...g, how: HOW_TO_CONFIRM[g.platform] ?? "Ask the user whether it went through." })),
    provisional_answers: unwrap(provisional).map((a) => [a.key ?? a.question.slice(0, 100), a.answer.slice(0, 120)]),
    next,
  };
}

const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function endSession(userId: string, input: { run_id: string; summary?: string; hurdles?: string }) {
  const run = unwrapMaybe(await db().from("runs").select("id, started_at, metadata").eq("id", input.run_id).eq("user_id", userId).maybeSingle());
  if (!run) throw notFound("Run");

  const apps = unwrap(
    await db().from("applications").select("id, platform, status, company_name").eq("user_id", userId).eq("run_id", run.id).limit(2000)
  );
  const counts: Record<string, Record<string, number>> = {};
  for (const a of apps) (counts[a.platform] ??= {})[a.status] = ((counts[a.platform] ??= {})[a.status] ?? 0) + 1;

  // Provisional answers that went into this run's applications (by answer_id, or by
  // an exact answer text distinctive enough to identify it).
  const company = new Map(apps.map((a) => [a.id, a.company_name]));
  const logged: { application_id: string; answer: string | null; answer_id: string | null }[] = [];
  const ids = apps.filter((a) => ["applied", "unconfirmed", "parked"].includes(a.status)).map((a) => a.id);
  for (let i = 0; i < ids.length; i += 200) {
    logged.push(
      ...unwrap(
        await db().from("application_questions").select("application_id, answer, answer_id").eq("user_id", userId).in("application_id", ids.slice(i, i + 200))
      )
    );
  }
  const provisional = unwrap(await db().from("answers").select("id, key, question, answer").eq("user_id", userId).eq("status", "provisional"));
  const used = provisional
    .map((p) => {
      const distinctive = p.answer.trim().length >= 4 && !/^(yes|no|\d+(\.\d+)?)$/i.test(p.answer.trim());
      const hits = logged.filter((l) => l.answer_id === p.id || (distinctive && norm(l.answer) === norm(p.answer)));
      return hits.length
        ? { field: p.key ?? p.question.slice(0, 100), value: p.answer.slice(0, 120), companies: [...new Set(hits.map((h) => company.get(h.application_id)))] }
        : null;
    })
    .filter(Boolean);

  await db()
    .from("runs")
    .update({
      ended_at: new Date().toISOString(),
      summary: input.summary ?? null,
      stats: counts as Json,
      metadata: { ...((run.metadata as Meta) ?? {}), ...(input.hurdles ? { hurdles: input.hurdles } : {}) } as Json,
    })
    .eq("id", run.id)
    .eq("user_id", userId);

  return {
    run_id: run.id,
    counts_by_platform: counts,
    provisional_answers_used: used,
    next: "Tell the user: the counts per platform above, what broke, and every provisional answer used with the companies that saw it.",
  };
}
