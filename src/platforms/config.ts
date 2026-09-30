/**
 * Engine config: everything a browser engine needs about the user, generated per
 * request from the profile, education, work history, saved answers and preferences.
 * Engines never hardcode a personal value; they read this.
 */

import { createHash } from "node:crypto";
import { getSupabaseClient } from "../db/supabase.js";
import { unwrap } from "../lib/errors.js";
import { getPreferences, getProfile, listEducations, listExperiences } from "../services/candidate.js";
import type { ScriptedPlatform } from "./ids.js";
import {
  JUNIOR_TITLE_TERMS,
  LINKEDIN_AGGREGATORS,
  LINKEDIN_GEO_IDS,
  NAUKRI_ALWAYS_EXTERNAL,
  SENIOR_TITLE_TERMS,
  SPAM_COMPANIES,
  STACK_VOCAB,
} from "./knowledge.js";

const db = () => getSupabaseClient();

type Profile = Awaited<ReturnType<typeof getProfile>>;
type Preferences = Awaited<ReturnType<typeof getPreferences>>;
type Education = Awaited<ReturnType<typeof listEducations>>[number];
type Experience = Awaited<ReturnType<typeof listExperiences>>[number];
type Answer = { id: string; key: string | null; question: string; answer: string; status: string };

export interface UserData {
  userId: string;
  profile: Profile;
  prefs: Preferences;
  educations: Education[];
  experiences: Experience[];
  answers: Answer[];
}

export async function loadUserData(userId: string): Promise<UserData> {
  const [profile, prefs, educations, experiences, answers] = await Promise.all([
    getProfile(userId),
    getPreferences(userId),
    listEducations(userId),
    listExperiences(userId),
    db()
      .from("answers")
      .select("id, key, question, answer, status")
      .eq("user_id", userId)
      .order("last_used_at", { ascending: false, nullsFirst: false })
      .limit(500),
  ]);
  return { userId, profile, prefs, educations, experiences, answers: unwrap(answers) };
}

export const rulesOf = (prefs: Preferences) => (prefs.rules ?? {}) as Record<string, any>;

// ---------------------------------------------------------------------------
// Answer pack
// ---------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthYear = (d: string | null) => (d ? [MONTHS[Number(d.slice(5, 7)) - 1] ?? null, d.slice(0, 4)] : [null, null]);
const perYear = (amount: number | null, period: string | null) =>
  amount == null ? null : period === "month" ? amount * 12 : period === "hour" ? amount * 2080 : amount;
const grade = (e: Education | undefined) => (e?.grade ? e.grade.replace(/%/g, "").trim() : null);

function educationFacts(educations: Education[]) {
  const text = (e: Education) => `${e.degree ?? ""} ${e.institution}`.toLowerCase();
  const g12 = educations.find((e) => /\b12(th)?\b|intermediate|hsc|higher secondary|senior secondary|\bpuc\b/.test(text(e)));
  const g10 = educations.find((e) => /\b10(th)?\b|\bssc\b|matric|secondary school certificate/.test(text(e)));
  const higher = educations.filter((e) => e !== g12 && e !== g10);
  const ug = higher.find((e) => /bachelor|b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|\bbca\b|\bba\b|undergrad/.test(text(e))) ?? higher[higher.length - 1];
  const top = higher[0] ?? ug;
  const [fromM, fromY] = monthYear(top?.start_date ?? null);
  const [toM, toY] = monthYear(top?.end_date ?? null);
  return {
    school: top?.institution ?? null,
    degree: top?.degree ?? null,
    major: top?.field_of_study ?? null,
    eduFromM: fromM, eduFromY: fromY, eduToM: toM, eduToY: toY,
    gradeUg: grade(ug), grade12: grade(g12), grade10: grade(g10),
  };
}

/** savedLimit: saved answers matched by exact question. Engines get the 60 most
    recently used (they ride in the pasted script); the server can afford all of them. */
export function answerPack(d: UserData, overrides?: Record<string, string>, savedLimit = 60) {
  const { profile: p, prefs } = d;
  const links = (p.links ?? {}) as Record<string, string>;
  const current = d.experiences.find((e) => e.is_current) ?? d.experiences[0];
  const [expFromM, expFromY] = monthYear(current?.start_date ?? null);
  const names = (p.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  const keyed: Record<string, string> = {};
  const saved: [string, string][] = [];
  for (const a of d.answers) {
    if (a.key) keyed[a.key] = a.answer;
    // Any saved answer (keyed or not) answers its own exact question.
    if (saved.length < savedLimit) saved.push([a.question.slice(0, 300), a.answer.slice(0, savedLimit > 60 ? 20000 : 400)]);
  }
  const rules = rulesOf(prefs);
  return {
    me: {
      fullName: p.full_name, firstName: names[0] ?? null, lastName: names.length > 1 ? names[names.length - 1] : null,
      preferredName: p.preferred_name, email: p.email, phone: p.phone,
      city: p.location_city, region: p.location_region, country: p.location_country,
      linkedin: links.linkedin ?? null, github: links.github ?? null, website: links.portfolio ?? links.website ?? null,
      currentCompany: p.current_company ?? current?.company ?? null,
      currentTitle: p.current_title ?? current?.title ?? null,
      years: p.years_experience,
      noticeDays: p.notice_period_days,
      earliest: p.earliest_start_date
        ? new Date(`${p.earliest_start_date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
        : null,
      ctcCurrent: perYear(p.current_salary, p.current_salary_period),
      ctcExpected: perYear(prefs.expected_salary, prefs.salary_period),
      relocate: prefs.willing_to_relocate,
      summary: p.summary,
      skills: p.skills,
      expFromM, expFromY,
      ...educationFacts(d.educations),
    },
    keyed,
    saved,
    overrides: Object.entries(overrides ?? {}).slice(0, 50),
    policy: { tech: rules.tech_questions === "skills" ? "skills" : "always_yes" },
  };
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Terms -> one case-insensitive regex source with alphanumeric boundaries, so ".net",
    "c#" and "sr." work and "lead" does not eat Naukri's "Leading Client". */
export function compileTerms(terms: (string | null | undefined)[]): string | null {
  const parts = [...new Set(terms.map((t) => (t ?? "").trim().toLowerCase()).filter(Boolean))].map((t) =>
    escRe(t).replace(/\s+/g, "[\\s-]?")
  );
  return parts.length ? `(?<![a-z0-9])(?:${parts.join("|")})(?![a-z0-9])` : null;
}

const normSkill = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();

/** Main technologies the user does not list: the JD stack check asks about these. */
export function missingStack(skills: string[]): [string, string][] {
  if (!skills.length) return [];
  const have = new Set(skills.map(normSkill));
  return STACK_VOCAB.filter((t) => !t.aliases.some((a) => have.has(normSkill(a)))).map((t) => [t.name, t.re]);
}

const slugTerm = (t: string) =>
  ({ "c#": "c-sharp|csharp", "c++": "cpp|c-plus-plus", ".net": "net|dotnet|dot-net" })[t.toLowerCase().trim()] ??
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function screening(d: UserData, platform: ScriptedPlatform) {
  const { prefs, profile } = d;
  const rules = rulesOf(prefs);
  const seniority = prefs.seniority_levels.join(" ").toLowerCase();
  const wantsSenior = /senior|lead|staff|principal|manager|director|head/.test(seniority);
  const wantsJunior = /intern|fresher|trainee/.test(seniority) || prefs.employment_types.some((t) => /intern/i.test(t));
  const negTitle = compileTerms([...(wantsSenior ? [] : SENIOR_TITLE_TERMS), ...(wantsJunior ? [] : JUNIOR_TITLE_TERMS)]);
  const base = {
    negTitle,
    negStack: compileTerms(prefs.exclude_keywords),
    pos: compileTerms(prefs.include_keywords),
    spam: compileTerms([...SPAM_COMPANIES, ...prefs.excluded_companies, ...(platform === "naukri" ? ["freelance", "freelancer"] : [])]),
    maxYears: prefs.max_years_required,
    minPay: perYear(prefs.min_salary, prefs.salary_period),
  };
  if (platform === "linkedin") {
    const roles = prefs.desired_roles.length ? prefs.desired_roles : [profile.current_title].filter(Boolean) as string[];
    const maxAge = prefs.max_posting_age_hours ?? 24;
    return {
      ...base,
      keywords: roles.slice(0, 12).map((r) => [r, 3] as [string, number]),
      windows: maxAge <= 1 ? ["r3600"] : ["r3600", "r86400"],
      location: profile.location_country ?? "India",
      geoId: LINKEDIN_GEO_IDS[(profile.location_country ?? "india").toLowerCase()] ?? null,
      agg: compileTerms(LINKEDIN_AGGREGATORS),
      stack: missingStack(profile.skills),
      jdExclude: compileTerms(Array.isArray(rules.jd_exclude_keywords) ? rules.jd_exclude_keywords : []),
      skipMidSenior: rules.skip_mid_senior_without_years !== false,
      target: Number(rules.linkedin?.draft_target) || 40,
    };
  }
  if (platform === "naukri") return { ...base, external: compileTerms(NAUKRI_ALWAYS_EXTERNAL) };
  if (platform === "wellfound") {
    const slugs = prefs.exclude_keywords.map(slugTerm).filter((s) => s.length >= 2);
    return {
      ...base,
      negSlug: slugs.length ? `(?:^|-)(?:${slugs.join("|")})(?:-|$)` : null,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Full config
// ---------------------------------------------------------------------------

export function engineConfig(
  d: UserData,
  platform: ScriptedPlatform,
  extra: { overrides?: Record<string, string>; known?: string[]; coverNote?: string | null; screen?: Record<string, unknown> } = {}
) {
  const cfg = {
    u: d.userId.slice(0, 8),
    ...answerPack(d, extra.overrides),
    screen: { ...screening(d, platform), ...(extra.screen ?? {}) },
    ...(extra.known ? { known: extra.known } : {}),
    ...(extra.coverNote ? { coverNote: extra.coverNote } : {}),
  };
  // h identifies this exact config, so a cached engine with stale answers is re-pasted.
  const h = createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 8);
  return { ...cfg, h };
}
