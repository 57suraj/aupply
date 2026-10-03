/**
 * POST /linkedin/apply/answers (sections 9.4 and 10.6): every field of one Easy Apply page,
 * answered in one batch, in this order:
 *   1. the deterministic rules (linkedin/fields.ts on the MCP's resolver),
 *   2. saved and past answers (find_similar_answers, the resolveAnswers rule),
 *   3. AI, only for a question no rule knows (or a long-form key with no value), never a
 *      personal fact, and only when its answer is a judgment or long-form text it is sure of,
 *   4. what is left goes to the user (ext_questions), a protected fact included.
 * Every answer is recorded on the lease (detail.pages), so the result can log the Q&A.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { unwrapMaybe } from "../../lib/errors.js";
import { answerPack, loadUserData, type UserData } from "../../platforms/config.js";
import type { ResolverAnswer } from "../../platforms/resolver.js";
import { findSimilarAnswers, markAnswersUsed, saveAnswerFromClaude, updateAnswer } from "../../services/answers.js";
import type { DeviceAuth } from "../auth/requireDevice.js";
import { AiBudgetExceeded, AiUnavailable, callJson } from "../ai/client.js";
import * as ANS from "../ai/prompts/answer.js";
import type { Action, AnswersRequest, AnswersResponse, Field } from "../contract.js";
import { engineDefs, resolverFor, type FullResolver } from "../engine/modules.js";
import { consentTicks, decideField, numberValue, type FieldCtx } from "../linkedin/fields.js";
import { conflict } from "../server/http.js";
import { addLeaseDetail, getLease } from "./leases.js";
import { getPosting } from "./postings.js";
import { noteQuestion } from "./questions.js";

const db = () => getSupabaseClient();

const MIN_SIMILARITY = 0.45;
const AI_MIN_CONFIDENCE = 0.7;
/** The long-form keys AI may write when the user has no value for them (section 10.6). */
const LONG_FORM = new Set(["pitch.summary", "why_seeking", "cover_note", "projects_text", "skills_text"]);
/** AI answers on one page run in parallel and must finish inside the function's time. */
const AI_DEADLINE_MS = 40_000;
const PROTECTED_KEYS = new Set(["dob", "government_id", "references", "address", "family"]);
const PERSONAL_TEXT = /salary|ctc|compensation|phone|mobile|e-?mail|address|date of birth|\bdob\b|passport|aadha|\bpan\b/i;

export interface QaEntry { question: string; answer: string; source: string; answer_id: string | null; field_type: string }

type Unknown = { f: Field; a: ResolverAnswer | null };

/** The saved answer behind a resolver answer, as resolveAnswers finds it (by question, else by key). */
function savedRow(d: UserData, R: FullResolver, label: string, a: ResolverAnswer | null) {
  if (!a) return null;
  const row = a.k === "saved" ? d.answers.find((x) => R.norm(x.question) === R.norm(label)) : d.answers.find((x) => x.key === a.k);
  return row && (a.k === "saved" || row.answer === a.v || row.answer === a.text) ? row : null;
}

/** Pick an option for an answer the way resolveAnswers does (pickOpt, then lowStakes). */
function optionFor(R: FullResolver, f: Field, answer: string): number {
  const options = f.options ?? [];
  const a: ResolverAnswer = { k: "similar", v: answer, yn: /^yes\b/i.test(answer) ? "yes" : /^no\b/i.test(answer) ? "no" : null };
  let i = R.pickOpt(a, options);
  if (i < 0) i = R.lowStakes(f.label, options);
  return i >= 0 && !f.option_values_empty?.[i] ? i : -1;
}

const isOptions = (f: Field) => f.kind === "select" || f.kind === "radio" || f.kind === "checkbox_group";

/** Saved and past answers for a question no rule could answer. A domain question takes only the
    user's own saved answer (past applications hold the old blanket Yes; resolveAnswers' rule). */
async function fromHistory(userId: string, R: FullResolver, d: UserData, u: Unknown): Promise<{ action: Action; qa: QaEntry; usedId: string | null } | null> {
  const domain = u.a?.k.startsWith("domain.") ?? false;
  const best = (await findSimilarAnswers(userId, u.f.label, 3)).find((m) => m.score >= MIN_SIMILARITY && (!domain || m.source === "saved"));
  if (!best) return null;
  const source = best.source === "saved" ? "saved" : "history";
  const answerId = best.source === "saved" ? best.id : null;
  if (isOptions(u.f)) {
    const i = optionFor(R, u.f, best.answer);
    if (i < 0) return null;
    return { action: { fid: u.f.fid, do: "choose", index: i }, qa: { question: u.f.label, answer: u.f.options![i], source, answer_id: answerId, field_type: u.f.kind }, usedId: answerId };
  }
  if (u.f.kind === "typeahead" || u.f.kind === "checkbox" || u.f.kind === "date_select") return null;
  const value = u.f.kind === "number" ? numberValue(best.answer, null, d.profile.years_experience) : best.answer;
  if (!value) return null;
  return { action: { fid: u.f.fid, do: "set", value }, qa: { question: u.f.label, answer: value, source, answer_id: answerId, field_type: u.f.kind }, usedId: answerId };
}

/** Section 10.6: AI is asked only for a required question no rule knows, or a long-form key with no value. */
function aiMayAnswer(u: Unknown): boolean {
  if (u.f.kind === "typeahead" || u.f.kind === "checkbox" || u.f.kind === "date_select") return false;
  const longForm = Boolean(u.a && LONG_FORM.has(u.a.k));
  // Any other resolver key is a known fact or rule: never AI (every personal fact the registry knows).
  if (u.a && !longForm) return false;
  return u.f.required || longForm;
}

function answerCandidate(d: UserData): ANS.AnswerCandidate {
  const p = d.profile;
  return {
    summary: p.summary,
    current_title: p.current_title,
    years: p.years_experience,
    skills: p.skills.slice(0, 60),
    work: d.experiences.slice(0, 8).map((e) => ({ title: e.title, company: e.company, highlights: (e.highlights ?? []).slice(0, 4) })),
    education: d.educations.slice(0, 4).map((e) => ({ degree: e.degree, field: e.field_of_study })),
    // Saved answers the user would share with any employer: never protected facts, money or contact details.
    saved: d.answers
      .filter((a) => !(a.key && (PROTECTED_KEYS.has(a.key) || a.key.startsWith("comp."))) && !PERSONAL_TEXT.test(a.question) && a.answer.length <= 300)
      .slice(0, 30)
      .map((a): [string, string] => [a.question.slice(0, 200), a.answer]),
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new AiUnavailable("timeout")), ms))]);

async function fromAi(
  userId: string,
  u: Unknown,
  ctx: { candidate: ANS.AnswerCandidate; resume: string; job: { title: string; company: string; jd: string } }
): Promise<{ action: Action; qa: QaEntry } | null> {
  try {
    const { data, model } = await withTimeout(
      callJson({
        userId, tier: "smart", purpose: "answer", system: ANS.SYSTEM, schema: ANS.FormAnswer, maxTokens: 1200,
        user: ANS.user({
          candidate: ctx.candidate, resume: ctx.resume, job: ctx.job,
          question: { label: u.f.label, kind: u.f.kind, options: u.f.options ?? null, max_length: u.f.max_length ?? null, required: u.f.required },
        }),
      }),
      AI_DEADLINE_MS
    );
    // A "fact" is never taken from AI, whatever it wrote (section 10.6).
    if (data.needs_user || data.kind === "fact" || data.confidence < AI_MIN_CONFIDENCE) return null;
    let action: Action;
    let answer: string;
    if (isOptions(u.f)) {
      const i = data.option_index;
      const options = u.f.options ?? [];
      if (i == null || i < 0 || i >= options.length || u.f.option_values_empty?.[i] || /^(select|choose|--|please)/i.test(options[i].trim())) return null;
      action = { fid: u.f.fid, do: "choose", index: i };
      answer = options[i];
    } else {
      let v = (data.answer ?? "").trim();
      if (u.f.kind === "number" && !/^\d+(\.\d+)?$/.test(v)) return null;
      const max = u.f.max_length ?? (u.f.kind === "textarea" ? 600 : 300);
      if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, "");
      if (!v) return null;
      action = { fid: u.f.fid, do: "set", value: v };
      answer = v;
    }
    let answerId: string | null = null;
    if (data.reusable) {
      const saved = await saveAnswerFromClaude(userId, { question: u.f.label.slice(0, 2000), answer, confirmed_by_user: false });
      if (saved.saved) {
        answerId = saved.answer.id;
        await updateAnswer(userId, saved.answer.id, { metadata: { origin: "extension_ai", model, at: new Date().toISOString() } });
      }
    }
    return { action, qa: { question: u.f.label, answer, source: "ai", answer_id: answerId, field_type: u.f.kind } };
  } catch (err) {
    if (err instanceof AiUnavailable || err instanceof AiBudgetExceeded) return null;
    throw err;
  }
}

export async function answerPage(dev: DeviceAuth, input: AnswersRequest): Promise<AnswersResponse> {
  const { userId } = dev;
  const lease = await getLease(userId, input.lease_id, dev.deviceId, "apply");
  if (lease.completed_at) throw conflict("This job's lease is already closed.");
  const d = await loadUserData(userId);
  const R = resolverFor(d);
  const { NEVERTICK, CONSENT } = engineDefs();
  const fctx: FieldCtx = { R, me: answerPack(d).me as Record<string, any>, company: input.company, NEVERTICK, CONSENT };

  const actions: Action[] = [];
  const qa: QaEntry[] = [];
  const used = new Set<string>();
  const unknowns: Unknown[] = [];
  const protectedOnes: { f: Field; what: string }[] = [];

  for (const f of input.fields) {
    const dec = decideField(f, fctx);
    if (dec.kind === "decided") {
      // A consent-only group can have several consent boxes: tick each.
      if (f.kind === "checkbox_group" && dec.qa?.source === "consent") actions.push(...consentTicks(f, fctx));
      else actions.push(dec.action);
      if (dec.qa) {
        const row = savedRow(d, R, f.label, dec.qa.a);
        if (row) used.add(row.id);
        qa.push({ question: dec.qa.question, answer: dec.qa.answer, source: dec.qa.source, answer_id: row?.id ?? null, field_type: f.kind });
      }
    } else if (dec.kind === "protected") protectedOnes.push({ f, what: dec.what });
    else unknowns.push({ f, a: dec.a });
  }

  // Saved and past answers.
  const stillUnknown: Unknown[] = [];
  for (const u of unknowns) {
    const h = await fromHistory(userId, R, d, u);
    if (h) {
      actions.push(h.action);
      qa.push(h.qa);
      if (h.usedId) used.add(h.usedId);
    } else stillUnknown.push(u);
  }

  // AI, for the questions it may answer (in parallel, bounded in time).
  let aiUsed = false;
  const forAi = protectedOnes.length ? [] : stillUnknown.filter(aiMayAnswer);
  const toUser: Unknown[] = stillUnknown.filter((u) => !forAi.includes(u));
  if (forAi.length) {
    const posting = lease.external_id ? await getPosting(lease.external_id) : null;
    const app = lease.application_id
      ? unwrapMaybe(await db().from("applications").select("job_title, company_name").eq("id", lease.application_id).eq("user_id", userId).maybeSingle())
      : null;
    const resume = unwrapMaybe(
      await db().from("resumes").select("content").eq("user_id", userId).is("archived_at", null).order("is_default", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle()
    );
    const ctx = {
      candidate: answerCandidate(d),
      resume: resume?.content ?? "",
      job: { title: app?.job_title ?? posting?.title ?? "", company: input.company || app?.company_name || "", jd: posting?.jd_text ?? "" },
    };
    const results = await Promise.all(forAi.map((u) => fromAi(userId, u, ctx)));
    results.forEach((res, i) => {
      if (res) {
        aiUsed = true;
        actions.push(res.action);
        qa.push(res.qa);
      } else toUser.push(forAi[i]);
    });
  }

  // What only the user can answer.
  const questions: { id: string; question: string; kind: "needs_input" | "protected" }[] = [];
  for (const p of protectedOnes) {
    const id = await noteQuestion(userId, { question: p.f.label, norm: R.norm(p.f.label), key: p.what, kind: "protected", field: p.f, applicationId: lease.application_id });
    questions.push({ id, question: p.f.label, kind: "protected" });
  }
  for (const u of toUser) {
    const key = u.a?.k && /^[a-z0-9_.]+$/.test(u.a.k) && !["saved", "similar", "override", "protected"].includes(u.a.k) ? u.a.k : null;
    const id = await noteQuestion(userId, { question: u.f.label, norm: R.norm(u.f.label), key, kind: "needs_input", field: u.f, applicationId: lease.application_id });
    questions.push({ id, question: u.f.label, kind: "needs_input" });
  }
  for (const u of toUser) actions.push({ fid: u.f.fid, do: "leave" });
  for (const p of protectedOnes) actions.push({ fid: p.f.fid, do: "leave" });

  if (used.size) await markAnswersUsed(userId, [...used]);
  const pages = { ...(((lease.detail as Record<string, any>) ?? {}).pages ?? {}) };
  pages[String(input.page.index)] = { progress: input.page.progress, qa, questions: questions.map((q) => q.id) };
  await addLeaseDetail(userId, lease, { pages });

  const verdict = protectedOnes.length ? "protected" : toUser.length ? "needs_input" : "fill";
  return { verdict, actions, ...(questions.length ? { questions } : {}), ai_used: aiUsed };
}
