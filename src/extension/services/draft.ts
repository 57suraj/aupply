/**
 * The draft (section 8): finding and scoring LinkedIn jobs. The page only fetches; the server
 * decides everything, keeps the state in ext_drafts, and hands out one small order at a time,
 * each under a lease (one open lease per user, so a draft never overlaps an apply or another
 * device). The MCP rules hold throughout: one guest search request a second, one JD read every
 * 1.5 seconds, a search 429 ends the searching for an hour, the first JD 429 pauses 10 minutes
 * and the second ends the reading (docs/automation-tools.md, Rate limits).
 *
 *   searching  orders of up to 5 search pages -> cards (first window wins)
 *   (filter)   title filter, dedup against applications, job-ad networks last, the shared cache
 *   reading    orders of up to 10 JD reads -> prescreen -> drops stored as skipped, keeps scored
 *   done       when target jobs are kept or nothing is left to read
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { check, unwrap, unwrapMaybe } from "../../lib/errors.js";
import { loadUserData, screening } from "../../platforms/config.js";
import { jobUrl, tryCanonicalJobId } from "../../platforms/ids.js";
import { activeBlock, linkedinCap, setBlock } from "../../services/automation.js";
import { rulesOf } from "../../platforms/config.js";
import type { DeviceAuth } from "../auth/requireDevice.js";
import type { DraftNextRequest, DraftOrder, DraftStartResponse, DraftSummary, PostedWithin } from "../contract.js";
import { jdUrl, PAGE_SIZE, parseCards, searchUrl } from "../linkedin/guest.js";
import { prescreen, prescreenText, type DropCode, type Keep, type ScreenRules } from "../linkedin/prescreen.js";
import { titleFilter, type TitleRules } from "../linkedin/titleFilter.js";
import { conflict, DISABLED_MESSAGE, forbidden, linkedinEnabled, notFoundExt, uid8 } from "../server/http.js";
import { logEvent } from "./events.js";
import { completeLease, getLease, issueLease, lastCompleted, type LeaseRow } from "./leases.js";
import { freshPostings, noteCards, storeJd } from "./postings.js";
import { extAt } from "./queue.js";
import { candidateBlock, extRules, resumeProfileFor } from "./resumeProfile.js";
import { scoreJob, type CardFacts, type ScoreCtx } from "./scoring.js";
import { claudeActivity, ownRun, patchRunMeta } from "./sessions.js";

const db = () => getSupabaseClient();

const RANK: Record<PostedWithin, number> = { "1h": 0, "24h": 1, "1w": 2 };
/** Pacing between the end of one draft lease and the start of the next. */
const ORDER_GAP_MS = 2000;
const SEARCH_GAP_MS = 1000;
const JD_GAP_MS = 1500;
const SEARCH_BATCH = 5;
const JD_BATCH = 10;
/** A backoff that ends within this long is waited out; a longer one ends the draft. */
const WAIT_LIMIT_MS = 2 * 3600_000;
/** Time spent scoring per request (the function runs at most 60 seconds). */
const SCORE_BUDGET_MS = 25_000;
const SCORE_CONCURRENCY = 4;

type Sc = TitleRules & ScreenRules & { searches: [string, PostedWithin, number][]; location: string; geoId: string | null };

interface State {
  sc: Sc;
  minFit: number;
  prog: { page: number; done: boolean }[];
  cand: Record<string, CardFacts>;
  jdQueue: string[];
  toScore: { id: string; keep: Keep }[];
  jdHits: number;
  stop: string | null;
}

interface Stats {
  found: number;
  title_dropped: Record<string, number>;
  already_known: number;
  read: number;
  cached: number;
  prescreen_dropped: Record<string, number>;
  low_fit: number;
  kept: number;
  decisions: number;
  http: Record<string, number>;
}

const emptyStats = (): Stats => ({ found: 0, title_dropped: {}, already_known: 0, read: 0, cached: 0, prescreen_dropped: {}, low_fit: 0, kept: 0, decisions: 0, http: {} });
const bump = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);

interface Ctx {
  dev: DeviceAuth;
  draft: { id: string; run_id: string; status: string; target: number; posted_within: string; updated_at: string };
  state: State;
  stats: Stats;
  /** Loaded on demand for scoring. */
  score?: ScoreCtx;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function save(ctx: Ctx, status?: string, stopReason?: string | null) {
  const rows = unwrap(
    await db()
      .from("ext_drafts")
      .update({
        state: ctx.state as unknown as Json,
        stats: ctx.stats as unknown as Json,
        ...(status ? { status } : {}),
        ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
      })
      .eq("id", ctx.draft.id)
      .eq("user_id", ctx.dev.userId)
      .eq("updated_at", ctx.draft.updated_at)
      .select("updated_at, status")
  );
  // Two calls for one draft at once: the second loses rather than overwrite the first.
  if (!rows.length) throw conflict("This draft changed meanwhile. Ask for the next order again.");
  ctx.draft.updated_at = rows[0].updated_at;
  ctx.draft.status = rows[0].status;
}

const summaryOf = (ctx: Ctx): DraftSummary => {
  const { http: _http, ...s } = ctx.stats;
  return { ...s, ...(ctx.state.stop ? { stop: ctx.state.stop } : {}) };
};

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function orderFromLease(l: LeaseRow): DraftOrder {
  const p = (l.payload as Record<string, any>) ?? {};
  const times = { lease_id: l.id, not_before: l.not_before, expires_at: l.expires_at };
  return l.kind === "search"
    ? { type: "search", ...times, gap_ms: SEARCH_GAP_MS, pages: p.pages ?? [] }
    : { type: "jd", ...times, gap_ms: JD_GAP_MS, jobs: p.jobs ?? [] };
}

async function openLeaseOf(ctx: Ctx) {
  return unwrapMaybe(
    await db()
      .from("ext_leases")
      .select("*")
      .eq("user_id", ctx.dev.userId)
      .eq("device_id", ctx.dev.deviceId)
      .in("kind", ["search", "jd"])
      .is("completed_at", null)
      .gt("expires_at", new Date().toISOString())
      .eq("payload->>draft_id", ctx.draft.id)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

/** A backoff or Claude at work: wait (or end the draft when the wait would be long). */
async function gate(ctx: Ctx): Promise<DraftOrder | null> {
  const block = await activeBlock(ctx.dev.userId, ["linkedin_guest", "linkedin"]);
  if (block?.until) {
    if (Date.parse(block.until) - Date.now() > WAIT_LIMIT_MS) {
      ctx.state.stop ??= "blocked";
      return finish(ctx);
    }
    return { type: "wait", until: block.until, reason: "rate_limited" };
  }
  const claude = await claudeActivity(ctx.dev.userId);
  if (claude) return { type: "wait", until: claude.retry_at, reason: "claude_active" };
  return null;
}

async function issue(ctx: Ctx, kind: "search" | "jd", payload: Record<string, unknown>): Promise<DraftOrder> {
  const last = await lastCompleted(ctx.dev.userId, ["search", "jd"]);
  const notBefore = new Date(Math.max(Date.now(), last?.completed_at ? Date.parse(last.completed_at) + ORDER_GAP_MS : 0));
  const issued = await issueLease(ctx.dev.userId, { deviceId: ctx.dev.deviceId, runId: ctx.draft.run_id, kind, notBefore, payload: { ...payload, draft_id: ctx.draft.id } });
  if (!issued.issued) return { type: "wait", until: issued.expires_at, reason: "lease_busy" };
  return orderFromLease(issued.lease);
}

/** The next (search, page) pairs: each active search's next page, freshest window first. */
function nextPairs(state: State) {
  const out: { url: string; s: number; page: number }[] = [];
  state.sc.searches.forEach(([keyword, window], s) => {
    const p = state.prog[s];
    if (p.done || out.length >= SEARCH_BATCH) return;
    out.push({ url: searchUrl({ keyword, location: state.sc.location, geoId: state.sc.geoId, window, page: p.page }), s, page: p.page });
  });
  return out;
}

async function finish(ctx: Ctx): Promise<DraftOrder> {
  const status = ctx.state.stop && ctx.state.stop !== "target" ? "stopped" : "done";
  ctx.state.jdQueue = [];
  ctx.state.toScore = [];
  await save(ctx, status, ctx.state.stop);
  await logEvent(ctx.dev.userId, { deviceId: ctx.dev.deviceId, runId: ctx.draft.run_id, level: ctx.state.stop?.startsWith("rate") ? "warn" : "info", type: "draft.done", data: { ...summaryOf(ctx), http: ctx.stats.http } });
  return { type: "done", summary: summaryOf(ctx) };
}

async function nextOrder(ctx: Ctx): Promise<DraftOrder> {
  const open = await openLeaseOf(ctx);
  if (open) return orderFromLease(open);

  if (ctx.draft.status === "searching") {
    const pairs = nextPairs(ctx.state);
    if (pairs.length) {
      const g = await gate(ctx);
      if (g) return g;
      return issue(ctx, "search", { pages: pairs });
    }
    await finishSearch(ctx);
  }

  await scoreSome(ctx);
  if (ctx.stats.kept >= ctx.draft.target) {
    ctx.state.stop ??= "target";
    return finish(ctx);
  }
  if (!ctx.state.jdQueue.length) {
    if (ctx.state.toScore.length) {
      await save(ctx);
      return { type: "wait", until: new Date().toISOString(), reason: "working" };
    }
    return finish(ctx);
  }
  await save(ctx);
  const g = await gate(ctx);
  if (g) return g;
  const jobs = ctx.state.jdQueue.slice(0, JD_BATCH).map((id) => ({ id, url: jdUrl(id) }));
  return issue(ctx, "jd", { jobs });
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

type SearchResult = { pages: { url: string; status: number; html: string }[]; stopped?: "rate_limited" };
type JdResult = { jobs: { id: string; status: number; html: string }[]; stopped?: "rate_limited" };

async function processSearch(ctx: Ctx, lease: LeaseRow, result: SearchResult) {
  const { state } = ctx;
  const asked = new Map(((lease.payload as Record<string, any>).pages ?? []).map((p: { url: string; s: number; page: number }) => [p.url, p]));
  let limited = result.stopped === "rate_limited";
  for (const r of result.pages) {
    const p = asked.get(r.url) as { s: number; page: number } | undefined;
    if (!p) continue;
    asked.delete(r.url);
    if (r.status === 429 || r.status === 999) {
      limited = true;
      break;
    }
    // Anything but a 200 reads as no cards, which ends that search's paging (li_sweep).
    const cards = r.status === 200 ? parseCards(r.html) : [];
    const window = state.sc.searches[p.s][1];
    for (const c of cards) {
      const id = tryCanonicalJobId("linkedin", c.id);
      if (!id) continue;
      const cur = state.cand[id];
      // First window wins: the freshest window a job was found in.
      if (!cur) state.cand[id] = { t: c.t, co: c.co, loc: c.loc, w: window };
      else if (RANK[window] < RANK[cur.w]) cur.w = window;
    }
    const prog = state.prog[p.s];
    if (prog.page === p.page) {
      prog.page += 1;
      if (cards.length < PAGE_SIZE || prog.page >= state.sc.searches[p.s][2]) prog.done = true;
    }
  }
  if (limited) {
    await setBlock(ctx.dev.userId, "linkedin_guest", new Date(Date.now() + 60 * 60_000), "LinkedIn guest search rate limited");
    state.stop = "rate_limited_search";
    state.prog.forEach((p) => (p.done = true));
  }
}

async function storeSkips(ctx: Ctx, skips: { id: string; code: DropCode }[]) {
  if (!skips.length) return;
  check(
    await db()
      .from("applications")
      .upsert(
        skips.map(({ id, code }) => {
          const c = ctx.state.cand[id];
          return {
            user_id: ctx.dev.userId, platform: "linkedin", external_id: id, job_url: jobUrl("linkedin", id),
            company_name: c?.co || "(unknown)", job_title: c?.t || "(unknown)", location: c?.loc || null,
            status: "skipped", status_reason: `draft: ${code}`, source: "sweep", run_id: ctx.draft.run_id,
            metadata: { skip_code: code, channel: "extension", draft_id: ctx.draft.id, ...extAt() } as Json,
          };
        }),
        { onConflict: "user_id,platform,external_id", ignoreDuplicates: true }
      )
  );
}

/** Every search is done: title filter, dedup, order, the shared cache, then the JD queue. */
async function finishSearch(ctx: Ctx) {
  const { state, stats, dev } = ctx;
  const tf = titleFilter(state.sc);
  const entries = Object.entries(state.cand);
  stats.found = entries.length;
  const survivors: string[] = [];
  for (const [id, c] of entries) {
    const why = tf.drop({ id, ...c });
    if (why) {
      bump(stats.title_dropped, why);
      continue;
    }
    c.agg = tf.agg({ id, ...c });
    survivors.push(id);
  }
  // Dedup before anything costly: one lookup on the unique index.
  const known = new Set<string>();
  for (let i = 0; i < survivors.length; i += 200) {
    const rows = unwrap(
      await db().from("applications").select("external_id").eq("user_id", dev.userId).eq("platform", "linkedin").in("external_id", survivors.slice(i, i + 200))
    );
    rows.forEach((r) => r.external_id && known.add(r.external_id));
  }
  stats.already_known = known.size;
  // Job-ad networks last (they land but never reply), then the freshest window first.
  const rest = survivors
    .filter((id) => !known.has(id))
    .sort((a, b) => (state.cand[a].agg ?? 0) - (state.cand[b].agg ?? 0) || RANK[state.cand[a].w] - RANK[state.cand[b].w]);
  await noteCards(dev.userId, rest.map((id) => ({ id, ...state.cand[id] })));
  // A JD another draft read in the last 72 hours is screened from the shared cache, not fetched.
  const fresh = await freshPostings(rest);
  const skips: { id: string; code: DropCode }[] = [];
  for (const id of rest) {
    const posting = fresh.get(id);
    if (!posting?.jd_text) {
      state.jdQueue.push(id);
      continue;
    }
    stats.cached++;
    const s = prescreenText(posting.jd_text, posting.ats, state.sc);
    if (s.verdict.code === "keep") state.toScore.push({ id, keep: s.verdict.keep });
    else {
      skips.push({ id, code: s.verdict.code });
      bump(stats.prescreen_dropped, s.verdict.code);
    }
  }
  await storeSkips(ctx, skips);
  // Searching stopped on a rate limit: the guest API is in a backoff, so nothing is read now.
  // Unread jobs are not stored; the next draft finds them again.
  if (state.stop) state.jdQueue = [];
  ctx.draft.status = "reading";
  await save(ctx, "reading");
}

// ---------------------------------------------------------------------------
// Reading and scoring
// ---------------------------------------------------------------------------

async function processJd(ctx: Ctx, lease: LeaseRow, result: JdResult) {
  const { state, stats, dev } = ctx;
  const asked = new Set(((lease.payload as Record<string, any>).jobs ?? []).map((j: { id: string }) => j.id));
  const skips: { id: string; code: DropCode }[] = [];
  let sign = false;
  for (const r of result.jobs) {
    if (!asked.has(r.id)) continue;
    // A 429, a 999 or an empty 200 is a rate limit, not "no years stated" (li_screen).
    if (r.status === 429 || r.status === 999 || (r.status === 200 && !r.html.trim())) {
      sign = true;
      break;
    }
    state.jdQueue = state.jdQueue.filter((x) => x !== r.id);
    if (r.status !== 200) {
      bump(stats.http, `HTTP_${r.status}`);
      continue;
    }
    stats.read++;
    const s = prescreen(r.html, state.sc);
    await storeJd(r.id, s, s.verdict.code === "keep" ? s.verdict.keep : null);
    if (s.verdict.code === "keep") state.toScore.push({ id: r.id, keep: s.verdict.keep });
    else {
      skips.push({ id: r.id, code: s.verdict.code });
      bump(stats.prescreen_dropped, s.verdict.code);
    }
  }
  if (!sign && result.stopped === "rate_limited") sign = true;
  await storeSkips(ctx, skips);
  if (sign) {
    state.jdHits++;
    if (state.jdHits >= 2) {
      // Second sign in this draft: end the reading; what survived so far is queued.
      await setBlock(dev.userId, "linkedin_guest", new Date(Date.now() + 60 * 60_000), "LinkedIn guest JD reads rate limited twice");
      state.stop = "rate_limited_jd";
      state.jdQueue = [];
    } else {
      // First: a 10 minute pause, then the job that hit it is read again first.
      await setBlock(dev.userId, "linkedin_guest", new Date(Date.now() + 10 * 60_000), "LinkedIn guest JD reads rate limited: a 10 minute pause");
    }
    await logEvent(dev.userId, { deviceId: dev.deviceId, runId: ctx.draft.run_id, level: "warn", type: "draft.rate_limited", data: { hits: state.jdHits } });
  }
}

async function scoreCtx(ctx: Ctx): Promise<ScoreCtx> {
  if (ctx.score) return ctx.score;
  const d = await loadUserData(ctx.dev.userId);
  const rp = await resumeProfileFor(d);
  ctx.score = { userId: ctx.dev.userId, runId: ctx.draft.run_id, draftId: ctx.draft.id, d, candidate: candidateBlock(d, rp.profile), basis: rp.basis, minFit: ctx.state.minFit };
  return ctx.score;
}

async function scoreSome(ctx: Ctx) {
  const { state, stats } = ctx;
  if (!state.toScore.length) return;
  const sc = await scoreCtx(ctx);
  const deadline = Date.now() + SCORE_BUDGET_MS;
  while (state.toScore.length && stats.kept < ctx.draft.target && Date.now() < deadline) {
    const batch = state.toScore.splice(0, SCORE_CONCURRENCY);
    const results = await Promise.all(batch.map((j) => scoreJob(sc, j.id, state.cand[j.id] ?? { t: "", co: "", loc: "", w: "24h" }, j.keep)));
    for (const r of results) {
      if (!r.inserted) continue; // the job reached the queue another way meanwhile
      if (r.status === "discovered") {
        stats.kept++;
        if (r.needsDecision) stats.decisions++;
      } else stats.low_fit++;
    }
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function startDraft(dev: DeviceAuth, input: { run_id: string; keywords?: string[]; target?: number }): Promise<DraftStartResponse> {
  const { userId } = dev;
  if (!linkedinEnabled()) return { type: "disabled", message: DISABLED_MESSAGE };
  const run = await ownRun(userId, dev.deviceId, input.run_id);
  const block = await activeBlock(userId, ["linkedin", "linkedin_guest"]);
  if (block) return { type: "blocked", scope: block.scope, until: block.until, reason: block.reason };
  const d = await loadUserData(userId);
  const capFull = await linkedinCap(userId, rulesOf(d.prefs));
  if (capFull.left <= 0) return { type: "cap_reached", cap: { cap: capFull.cap, used: capFull.used, left: capFull.left } };
  const within = (run.metadata.posted_within ?? "24h") as PostedWithin;
  const keywords = input.keywords?.length ? input.keywords : (run.metadata.keywords as string[] | undefined);
  const sc = screening(d, "linkedin", { within, keywords }) as ReturnType<typeof screening> & Partial<Sc> & { target?: number };
  const searches = (sc.searches ?? []) as Sc["searches"];
  if (!searches.length) return { type: "no_roles", message: "Add the roles you want (desired roles) to your Aupply profile first." };
  const ext = extRules(d);
  const target = Math.min(100, Math.max(1, input.target || Number(run.metadata.target) || ext.draftTarget || Number(sc.target) || 40));

  // A draft of this run left unfinished (the extension restarted) is closed first.
  check(
    await db().from("ext_drafts").update({ status: "stopped", stop_reason: "replaced" }).eq("user_id", userId).eq("run_id", run.id).in("status", ["searching", "reading"])
  );
  const state: State = {
    sc: {
      searches, location: sc.location ?? "India", geoId: sc.geoId ?? null,
      negTitle: sc.negTitle, negStack: sc.negStack, pos: sc.pos, spam: sc.spam, agg: sc.agg ?? null, maxYears: sc.maxYears,
      jdExclude: sc.jdExclude ?? null, skipMidSenior: sc.skipMidSenior ?? true, minPay: sc.minPay,
      stack: (sc.stack ?? []) as [string, string][], noStack: sc.noStack ?? [],
    },
    minFit: ext.minFit,
    prog: searches.map(() => ({ page: 0, done: false })),
    cand: {},
    jdQueue: [],
    toScore: [],
    jdHits: 0,
    stop: null,
  };
  const draft = unwrap(
    await db()
      .from("ext_drafts")
      .insert({ user_id: userId, run_id: run.id, device_id: dev.deviceId, posted_within: within, target, state: state as unknown as Json, stats: emptyStats() as unknown as Json })
      .select("id, run_id, status, target, posted_within, updated_at")
      .single()
  );
  await patchRunMeta(userId, run, { phase: "drafting", draft_id: draft.id });
  console.log(`[ext] draft started user=${uid8(userId)} searches=${searches.length} target=${target}`);
  const ctx: Ctx = { dev, draft, state, stats: emptyStats() };
  const order = await nextOrder(ctx);
  return {
    type: "started",
    draft_id: draft.id,
    searching: { posted_within: within, roles: [...new Set(searches.map((s) => s[0]))], windows: [...new Set(searches.map((s) => s[1]))] },
    order,
  };
}

export async function nextDraft(dev: DeviceAuth, input: DraftNextRequest): Promise<DraftOrder> {
  const { userId } = dev;
  if (!linkedinEnabled()) return { type: "disabled", message: DISABLED_MESSAGE };
  const row = unwrapMaybe(
    await db().from("ext_drafts").select("id, run_id, device_id, status, target, posted_within, state, stats, updated_at").eq("id", input.draft_id).eq("user_id", userId).maybeSingle()
  );
  if (!row) throw notFoundExt("Draft");
  if (row.device_id !== dev.deviceId) throw forbidden("This draft belongs to another device.");
  const ctx: Ctx = {
    dev,
    draft: { id: row.id, run_id: row.run_id, status: row.status, target: row.target, posted_within: row.posted_within, updated_at: row.updated_at },
    state: row.state as unknown as State,
    stats: { ...emptyStats(), ...(row.stats as unknown as Partial<Stats>) },
  };
  if (!["searching", "reading"].includes(row.status)) return { type: "done", summary: summaryOf(ctx) };
  try {
    await ownRun(userId, dev.deviceId, row.run_id);
  } catch {
    ctx.state.stop ??= "run_ended";
    return finish(ctx);
  }

  if (input.lease_id) {
    const lease = await getLease(userId, input.lease_id, dev.deviceId, ["search", "jd"]);
    if ((lease.payload as Record<string, unknown>)?.draft_id !== row.id) throw conflict("This lease belongs to another draft.");
    // A result for a lease already completed was processed before: answer with the next order.
    if (!lease.completed_at && input.result) {
      if (lease.kind === "search" && "pages" in input.result) await processSearch(ctx, lease, input.result);
      else if (lease.kind === "jd" && "jobs" in input.result) await processJd(ctx, lease, input.result);
      else throw conflict("This result does not match the lease's kind.");
      const done = await completeLease(userId, lease, "DONE");
      if (!done.first) throw conflict("This result was already recorded.");
      await save(ctx);
    }
  }
  return nextOrder(ctx);
}
