/**
 * Scoring a job that survived the prescreen (section 8.5): the posting's AI facts (shared per
 * job), the user's resume profile (cached per resume version), then a fit score. No AI (no key,
 * budget spent, errors): the deterministic score queue_jobs uses. The result is the job's queue
 * row: discovered at or above the user's minimum fit, skipped below it.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { unwrap } from "../../lib/errors.js";
import type { UserData } from "../../platforms/config.js";
import { jobUrl } from "../../platforms/ids.js";
import { AiBudgetExceeded, AiUnavailable, callJson } from "../ai/client.js";
import * as FIT from "../ai/prompts/fit.js";
import * as JD from "../ai/prompts/jdFacts.js";
import type { PostedWithin } from "../contract.js";
import type { Keep } from "../linkedin/prescreen.js";
import { getPosting, storeAiFacts } from "./postings.js";

const db = () => getSupabaseClient();

export interface CardFacts { t: string; co: string; loc: string; w: PostedWithin; agg?: number }

export interface ScoreCtx {
  userId: string;
  runId: string;
  draftId: string;
  d: UserData;
  candidate: FIT.Candidate;
  /** Where the candidate block came from: the resume, or the profile fields alone. */
  basis: "resume" | "profile";
  minFit: number;
}

/** queue_jobs' score() (src/services/automation.ts), the same arithmetic, for when no AI answers. */
export function fallbackScore(card: CardFacts, keep: Keep, maxYears: number | null): number {
  let s = 50;
  if (card.w === "1h") s += 30;
  if (card.w === "1w") s -= 15;
  if (card.agg) s -= 40;
  if (keep.yu) s -= 5;
  if (keep.minY != null && maxYears != null && keep.minY <= maxYears) s += 10;
  if (keep.sm.length) s -= 10;
  return Math.max(0, Math.min(100, s));
}

const aiDown = (err: unknown) => err instanceof AiUnavailable || err instanceof AiBudgetExceeded;

async function jdFacts(ctx: ScoreCtx, id: string, card: CardFacts): Promise<{ facts: JD.JdFacts | null; jd: string }> {
  const posting = await getPosting(id);
  const jd = posting?.jd_text ?? "";
  if (posting?.ai_version === JD.PROMPT_VERSION) {
    const cached = JD.JdFacts.safeParse(posting.ai_facts);
    if (cached.success) return { facts: cached.data, jd };
  }
  if (!jd) return { facts: null, jd };
  try {
    const r = await callJson({
      userId: ctx.userId, tier: "fast", purpose: "jd_facts", system: JD.SYSTEM,
      user: JD.user({ title: card.t, company: card.co, location: card.loc, jd }), schema: JD.JdFacts, maxTokens: 900,
    });
    await storeAiFacts(id, r.data, r.model, JD.PROMPT_VERSION);
    return { facts: r.data, jd };
  } catch (err) {
    if (aiDown(err)) return { facts: null, jd };
    throw err;
  }
}

export interface Scored { id: string; inserted: boolean; status: "discovered" | "skipped"; score: number; needsDecision: boolean; basis: string }

export async function scoreJob(ctx: ScoreCtx, id: string, card: CardFacts, keep: Keep): Promise<Scored> {
  const { facts, jd } = await jdFacts(ctx, id, card);
  let ai: (FIT.Fit & { model: string; v: string; basis: string }) | null = null;
  if (facts) {
    try {
      const r = await callJson({
        userId: ctx.userId, tier: "fast", purpose: "fit", system: FIT.SYSTEM,
        user: FIT.user({ candidate: ctx.candidate, facts, jd }), schema: FIT.Fit, maxTokens: 400,
      });
      ai = { ...r.data, model: r.model, v: FIT.PROMPT_VERSION, basis: ctx.basis };
    } catch (err) {
      if (!aiDown(err)) throw err;
    }
  }
  const score = ai ? ai.score : fallbackScore(card, keep, ctx.d.prefs.max_years_required);
  const meta = ai ?? { score, verdict: FIT.verdictOf(score), reasons: [], gaps: [], model: null, v: FIT.PROMPT_VERSION, basis: "fallback" };
  const discovered = score >= ctx.minFit;
  const needsDecision = keep.sm.length > 0;
  const rows = unwrap(
    await db()
      .from("applications")
      .upsert(
        {
          user_id: ctx.userId, platform: "linkedin", external_id: id, job_url: jobUrl("linkedin", id),
          company_name: card.co || "(unknown)", job_title: card.t || "(unknown)", location: card.loc || null,
          experience_min_years: keep.minY ?? null, source: "sweep", run_id: ctx.runId,
          status: discovered ? "discovered" : "skipped",
          status_reason: discovered ? null : `draft: LOW_FIT ${score}`,
          match_score: score,
          metadata: {
            w: card.w, agg: card.agg ?? 0, lvl: keep.lvl, pay: keep.pay, sm: keep.sm, yu: keep.yu ?? 0,
            needs_decision: needsDecision, channel: "extension", draft_id: ctx.draftId,
            ai: { score: meta.score, verdict: meta.verdict, reasons: meta.reasons, gaps: meta.gaps, model: meta.model, v: meta.v, basis: meta.basis },
          } as Json,
        },
        { onConflict: "user_id,platform,external_id", ignoreDuplicates: true }
      )
      .select("id")
  );
  if (!rows.length) {
    // Already stored: by this same draft on an attempt that failed half way (counts again), or
    // another way meanwhile (does not count).
    const { data: prior } = await db()
      .from("applications")
      .select("status, metadata")
      .eq("user_id", ctx.userId)
      .eq("platform", "linkedin")
      .eq("external_id", id)
      .maybeSingle();
    const m = (prior?.metadata as Record<string, any> | null) ?? {};
    const ours = m.draft_id === ctx.draftId && (prior?.status === "discovered" || prior?.status === "skipped");
    return { id, inserted: ours, status: (prior?.status as "discovered" | "skipped") ?? "skipped", score: Number(m.ai?.score ?? score), needsDecision: Boolean(m.needs_decision), basis: meta.basis };
  }
  return { id, inserted: true, status: discovered ? "discovered" : "skipped", score, needsDecision, basis: meta.basis };
}
