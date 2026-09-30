/**
 * resolve_answers: answer form questions the way the engines do (same resolver, same
 * user data), then fall back to fuzzy matches against saved answers and past
 * applications. Used when an engine returns NEEDS_INPUT and when Claude fills a form
 * by hand, so both paths give the same answers.
 */

import { answerPack, loadUserData } from "../platforms/config.js";
import { makeResolver, SOURCE_NAMES, type ResolverAnswer } from "../platforms/resolver.js";
import { findSimilarAnswers } from "./answers.js";

export interface QuestionIn {
  q: string;
  options?: string[];
  field?: "text" | "number" | "select" | "radio" | "checkbox" | "textarea";
  company?: string;
}

// Answers that come straight from what the user entered in their profile.
const PROFILE_KEYS = new Set([
  "experience.years", "experience.months", "experience.additional_months", "comp.current", "comp.expected",
  "notice.days", "start.earliest_date", "start.immediately", "location.city", "location.country", "location.based_in",
  "name.full", "name.first", "name.last", "name.preferred", "email", "phone", "links.linkedin", "links.portfolio",
  "education.major", "education.school", "education.degree", "education.grade", "education.grade_12",
  "education.grade_10", "education.has_degree", "employment.current_company", "employment.current_title",
  "pitch.summary", "skills_text", "role.category",
]);

const MIN_SIMILARITY = 0.45;

export async function resolveAnswers(userId: string, input: { questions: QuestionIn[]; platform?: string }) {
  const d = await loadUserData(userId);
  const source = SOURCE_NAMES[(input.platform ?? "").toLowerCase()] ?? input.platform ?? "LinkedIn";
  const R = makeResolver(answerPack(d, undefined, 1000), source);
  const byKey = new Map(d.answers.filter((a) => a.key).map((a) => [a.key as string, a]));
  const byQuestion = new Map(d.answers.map((a) => [R.norm(a.question), a]));
  const years = d.profile.years_experience;

  const pick = (a: ResolverAnswer | null, item: QuestionIn) => {
    if (!item.options?.length) return {};
    let i = R.pickOpt(a, item.options);
    if (i < 0) i = R.lowStakes(item.q, item.options);
    return i >= 0 ? { option: item.options[i] } : { option: null, note: "no option matches: ask the user" };
  };
  // A numeric field never gets "Yes": the years for a positive answer, 0 for a negative.
  const numeric = (answer: string, item: QuestionIn) =>
    item.field !== "number" || /^\d+(\.\d+)?$/.test(answer) ? answer : /^no$/i.test(answer) ? "0" : years != null ? String(years) : answer;

  return Promise.all(
    input.questions.map(async (item) => {
      const q = item.q.slice(0, 120);
      const a = R.A(item.q);
      if (a?.protected) {
        return { q, status: "protected", key: a.what, note: "Aupply never invents this: ask the user, or skip the job" };
      }
      if (a && a.v != null) {
        const answer = numeric(String(a.text ?? a.v), item);
        const row = a.k === "saved" ? byQuestion.get(R.norm(item.q)) : byKey.get(a.k);
        const fromRow = row && (a.k === "saved" || row.answer === a.v || row.answer === a.text);
        return {
          q,
          answer,
          ...pick(a, item),
          source: a.k === "saved" ? "saved" : `registry:${a.k}`,
          status: fromRow ? row.status : PROFILE_KEYS.has(a.k) ? "confirmed" : "provisional",
          ...(fromRow ? { answer_id: row.id } : {}),
        };
      }
      // A known question the user has not answered, or no rule at all: past answers.
      const best = (await findSimilarAnswers(userId, item.q, 3)).find((m) => m.score >= MIN_SIMILARITY);
      if (best) {
        const answer = numeric(best.answer, item);
        return {
          q,
          answer,
          ...pick({ k: "similar", v: answer, yn: /^yes\b/i.test(answer) ? "yes" : /^no\b/i.test(answer) ? "no" : null }, item),
          source: best.source === "saved" ? "saved" : "history",
          status: best.status || "provisional",
          similar_to: best.question.slice(0, 120),
          ...(best.source === "saved" ? { answer_id: best.id } : {}),
        };
      }
      if (item.options?.length) {
        const i = R.lowStakes(item.q, item.options);
        if (i >= 0) return { q, option: item.options[i], source: "registry:low_stakes", status: "provisional" };
      }
      return { q, status: "unknown", ...(a ? { key: a.k } : {}), note: "ask the user, then save the reply with save_answer" };
    })
  );
}
