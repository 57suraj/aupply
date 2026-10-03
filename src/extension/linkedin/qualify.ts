/**
 * The qualifying-Yes rule (the user, 4 Oct 2026, during the first live test): "answer yes for
 * things that would otherwise result in rejecting the application when the question is non
 * quantitative and non personal". It covers the screening questions no resolver rule knows, such as
 * "Have you personally built Python scripts or backend services that process files, automate
 * workflows, or integrate APIs, beyond coursework?" or "Have you configured or troubleshot AWS S3
 * uploads ... on Linux servers?" (both asked again and again in that test: BUGS.md B1).
 *
 * It applies only when every one of these holds:
 *  - no rule answered the question and no saved or past answer of the user's matched it (the
 *    caller's order), so a rule's No (a far technology) or the user's own No always wins;
 *  - it is a yes/no question (Have/Do/Are/Can/... with a Yes option, or a short text field);
 *  - it claims experience, skill, ability, comfort or readiness (QUALIFY);
 *  - it is not quantitative (no counts, years, money, ratings: QUANT);
 *  - it is not personal (licences, visas, location, notice, pay, age, health, family, background,
 *    certifications, schedules, work arrangements, consent and the like: PERSONAL);
 *  - it names no technology from a language or platform the user has no foothold in, and none the
 *    user excluded (the technology policy of 1 Oct still answers No for those).
 * AI never decides this; the rule is deterministic and logged as source "rule:qualify".
 */

import type { Field } from "../contract.js";
import type { FullResolver } from "../engine/modules.js";
import type { ResolverAnswer } from "../../platforms/resolver.js";

const QUESTION = /^(have|has|do|does|did|are|is|can|could|would|will|were|was|any)\b/i;
const QUALIFY =
  /\b(experience[ds]?|worked (with|on|in)|work(ing)? (with|on|in)|used|use|using|familiar|proficien\w*|knowledge|know|built|build(ing)?|develop\w*|design\w*|implement\w*|deploy\w*|configur\w*|troubleshoot\w*|debug\w*|integrat\w*|automat\w*|written|wrote|write|hands.?on|comfortable|able to|capable|ready to|willing to|open to|okay with|ok with|exposure|understand\w*|skilled|expertise|handled|manag\w*|maintain\w*|contribut\w*|creat\w*|shipp\w*|deliver\w*|led|lead)\b/i;
const QUANT =
  /how (many|much|long|often|soon)|number of|\d+\s*\+?\s*(years?|yrs?|months?)|\byears?\b|\bmonths?\b|\bdays?\b|percent|%|rate (yourself|your)|rating|scale|out of|salary|ctc|lpa|stipend|compensation|\bpay\b/i;
const PERSONAL = new RegExp(
  [
    "licen[cs]e", "visa", "passport", "sponsor", "authori[sz]", "citizen", "nationality", "right to work", "eligible to work",
    "relocat", "commut", "located", "reside", "where (do|will) you live", "liv(e|ing) in\\b", "based (in|out)", "\\bnear\\b", "distance", "notice", "join(ing)?\\b", "start (date|immediately|work)",
    "available to start", "\\bage\\b", "date of birth", "born", "gender", "disab", "veteran", "ethnic", "\\brace\\b", "religio", "marital",
    "married", "pregnan", "health", "medical", "criminal", "convict", "arrest", "background (check|verification)", "drug", "reference",
    "family", "father", "mother", "spouse", "currently employ", "previously (worked|employed)", "worked (for|at)\\b", "employee of",
    "referr", "non.?compete", "\\bbond\\b", "service agreement", "shift", "night", "weekend", "travel", "on.?site", "in.?office",
    "from (the )?office", "office (location|days)", "hybrid", "remote", "\\bhours\\b", "overtime", "laptop", "vehicle", "two.?wheeler", "bike", "\\bcar\\b", "degree",
    "graduat", "cgpa", "\\bgpa\\b", "marks", "certif", "clearance", "english", "hindi", "speak", "fluent", "consent",
    "agree", "privacy", "terms", "declare", "acknowledge", "accurate", "true and correct", "fresher", "first job", "\\bgap\\b",
    "interview", "job offer", "offer letter", "contract (role|position|basis|job)", "freelanc", "full.?time", "part.?time", "\\bintern(ship)?s?\\b",
  ].join("|"),
  "i"
);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();

export interface QualifyCtx {
  R: FullResolver;
  /** answerPack(d).policy.far: technologies with no foothold (regex source). */
  far: string | null;
  skills: string[];
  /** Technologies the user excluded by name (STACK_VOCAB patterns). */
  excluded: string[];
}

/** Does the yes-rule cover this question? (The caller has already ruled out rules and saved answers.) */
export function qualifies(label: string, a: ResolverAnswer | null, ctx: QualifyCtx): boolean {
  const q = label.replace(/\s+/g, " ").trim();
  if (!q || !QUESTION.test(q) || !QUALIFY.test(q) || QUANT.test(q) || PERSONAL.test(q)) return false;
  // A rule that knows the question and found the user's value missing is a fact for the user
  // (a domain, a licence): only long-form keys a yes/no question was misread as, or none, pass.
  if (a && a.v == null && !["projects_text", "skills_text", "pitch.summary", "cover_note", "why_seeking", "experience.tech"].includes(a.k)) return false;
  if (a && a.v != null) return false;
  const text = ` ${norm(q)} `;
  const ownSkill = ctx.skills.map(norm).filter(Boolean).some((s) => text.includes(` ${s} `));
  if (ctx.far && new RegExp(ctx.far, "i").test(q) && !ownSkill) return false;
  if (ctx.excluded.some((re) => new RegExp(re, "i").test(q))) return false;
  return true;
}

/** The Yes for a field: an option index, a text value, or null when the field cannot take a Yes. */
export function yesFor(f: Field, R: FullResolver): { index: number } | { value: string } | null {
  if (f.kind === "radio" || f.kind === "select" || f.kind === "checkbox_group") {
    const options = f.options ?? [];
    const i = R.pickOpt({ k: "qualify", v: "Yes", yn: "yes" }, options);
    if (i < 0 || f.option_values_empty?.[i] || !/^yes\b/i.test(options[i].trim())) return null;
    return { index: i };
  }
  if (f.kind === "text") return { value: "Yes" };
  return null;
}
