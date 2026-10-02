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
import type { PostedWithin } from "../domain/schemas.js";
import {
  JUNIOR_TITLE_TERMS,
  TEACHING_TITLE_TERMS,
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

/** The number as a phone field with its own country selector wants it: digits without the
    country code. A live run (30 Sep) typed "+91 98765 43210" into LinkedIn's field, and the
    form's numeric repair then glued the code on ("919876543210"), so every job stalled. */
export function nationalNumber(phone: string | null | undefined, country?: string | null): string | null {
  const raw = (phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  // "+91 98765 43210", "+91-9876543210", "0091 9876543210", "+1 (555) 123-4567": a code set off from the number.
  const set = raw.match(/^(?:\+|00)\s*(\d{1,3})[\s\-.()]+(\d[\d\s\-.()]*)$/);
  if (set) return set[2].replace(/\D/g, "");
  if (/^(?:\+|00)/.test(raw)) {
    // "+919876543210": no separator. India is the v1 market: 91 and ten digits. Other codes are left as typed.
    return /^91\d{10}$/.test(digits.replace(/^00/, "")) ? digits.replace(/^00/, "").slice(2) : digits;
  }
  if (/^india$/i.test(country ?? "") && /^91\d{10}$/.test(digits)) return digits.slice(2);
  return digits.replace(/^0+(?=\d{10}$)/, "");
}

/** savedLimit: saved answers matched by exact question. Engines get the 60 most
    recently used short ones (they ride in the config parts; a long answer is left out
    rather than cut, and resolve_answers still finds it); the server can afford all. */
export function answerPack(d: UserData, overrides?: Record<string, string>, savedLimit = 60) {
  const { profile: p, prefs } = d;
  const links = (p.links ?? {}) as Record<string, string>;
  const current = d.experiences.find((e) => e.is_current) ?? d.experiences[0];
  const [expFromM, expFromY] = monthYear(current?.start_date ?? null);
  const names = (p.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  const keyed: Record<string, string> = {};
  const saved: [string, string][] = [];
  // d.answers is most recently used first: the first answer for a key or a question wins
  // (a Map built from the list would keep the oldest). Sorted by question afterwards, so the
  // config's hash, and with it the engine cached in the page, changes only when an answer
  // does, not each time one is used.
  const seen = new Set<string>();
  const qkey = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const a of d.answers) {
    if (a.key && !(a.key in keyed)) keyed[a.key] = a.answer;
    // Any saved answer (keyed or not) answers its own exact question.
    const q = qkey(a.question);
    if (q && !seen.has(q) && saved.length < savedLimit && (savedLimit > 60 || a.answer.length <= 600)) {
      seen.add(q);
      saved.push([a.question.slice(0, 300), a.answer]);
    }
  }
  saved.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const rules = rulesOf(prefs);
  return {
    me: {
      fullName: p.full_name, firstName: names[0] ?? null, lastName: names.length > 1 ? names[names.length - 1] : null,
      preferredName: p.preferred_name, email: p.email, phone: p.phone, phoneNational: nationalNumber(p.phone, p.location_country),
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
    // Technology questions: Yes for the user's skills and anything learnable next to them, No for
    // a far technology (strict mode "skills": Yes for their skills only, anything else asked).
    policy: {
      tech: rules.tech_questions === "skills" ? "skills" : "adjacent",
      far: farStack(p.skills).map((t) => `(?:${t.q ?? t.re})`).join("|") || null,
    },
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

/** With no include_keywords, a LinkedIn draft still needs a positive title filter: keyword search
    matches the whole posting, so "AI developer" returned AI/ML Trainer, Quantitative Researcher and
    Data Warehouse Specialist (2 Oct), all queued and sent. The filter is the words of the user's
    desired roles plus the usual engineering nouns; no roles listed means no filter. */
const ROLE_NOUNS = ["engineer", "developer", "sde", "programmer", "software", "swe", "full stack", "fullstack", "backend", "back end", "frontend", "front end", "devops", "ml", "ai"];
export function rolePositive(roles: string[]): string | null {
  if (!roles.length) return null;
  // Fragments of "full stack", "back end" and "front end" are left out as words of their own ("Full Time Customer Support"
  // would match "full"); the phrases are in ROLE_NOUNS.
  const skip = new Set(["and", "of", "the", "for", "to", "full", "stack", "back", "front", "end"]);
  const words = roles.flatMap((r) => r.toLowerCase().split(/[^a-z0-9+#]+/)).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !skip.has(w));
  return compileTerms([...words, ...ROLE_NOUNS]);
}

const normSkill = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();

/** Main technologies the user has no foothold in (knowledge.ts STACK_VOCAB): the draft's stack
    check asks about jobs that name one, and the form answers No / 0 years for them. With no
    skills listed nothing is far: every answer stays Yes rather than No. */
export function farStack(skills: string[]) {
  if (!skills.length) return [];
  const have = new Set(skills.map(normSkill));
  return STACK_VOCAB.filter((t) => !t.aliases.some((a) => have.has(normSkill(a))));
}

/** The technologies the user excluded by name (preferences.exclude_keywords, such as "PHP" or
    ".NET"): a job whose description names one is skipped, never asked about (2 Oct: a user who
    said "skip PHP and .NET" was asked about, or nearly sent to, PHP and .NET jobs, because only
    titles were checked). Matched with each technology's own pattern, so excluding "angular"
    never excludes React, which only lists Angular among its footholds. */
export function excludedStacks(keywords: string[]) {
  return STACK_VOCAB.filter((t) => keywords.some((k) => new RegExp(t.re, "i").test(` ${k.trim()} `)));
}

const slugTerm = (t: string) =>
  ({ "c#": "c-sharp|csharp", "c++": "cpp|c-plus-plus", ".net": "net|dotnet|dot-net" })[t.toLowerCase().trim()] ??
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The windows each posted_within choice sweeps, freshest first, and the result pages per
    keyword in each window (a week reaches past the newest postings the 24h pages hold). */
const LINKEDIN_WINDOWS: Record<PostedWithin, PostedWithin[]> = { "1h": ["1h"], "24h": ["1h", "24h"], "1w": ["1h", "24h", "1w"] };
const LINKEDIN_PAGES: Record<PostedWithin, number> = { "1h": 3, "24h": 3, "1w": 5 };

/** The user's standing preference when a session names no window. */
export const defaultWithin = (maxAgeHours: number | null | undefined): PostedWithin =>
  (maxAgeHours ?? 24) <= 1 ? "1h" : (maxAgeHours ?? 24) <= 24 ? "24h" : "1w";

/** The searches a LinkedIn draft runs, decided here and run as given by the engine:
    [keyword, window, pages], every keyword in the freshest window first. */
export function linkedinSearches(keywords: string[], within: PostedWithin): [string, PostedWithin, number][] {
  return LINKEDIN_WINDOWS[within].flatMap((w) => keywords.map((k): [string, PostedWithin, number] => [k, w, LINKEDIN_PAGES[w]]));
}

export function screening(d: UserData, platform: ScriptedPlatform, li: { within?: PostedWithin; keywords?: string[] } = {}) {
  const { prefs, profile } = d;
  const rules = rulesOf(prefs);
  const seniority = prefs.seniority_levels.join(" ").toLowerCase();
  const wantsSenior = /senior|lead|staff|principal|manager|director|head/.test(seniority);
  const wantsJunior = /intern|fresher|trainee/.test(seniority) || prefs.employment_types.some((t) => /intern/i.test(t));
  const rolesText = prefs.desired_roles.join(" ").toLowerCase();
  const teaching = TEACHING_TITLE_TERMS.filter((t) => !rolesText.includes(t));
  const negTitle = compileTerms([...(wantsSenior ? [] : SENIOR_TITLE_TERMS), ...(wantsJunior ? [] : JUNIOR_TITLE_TERMS), ...(platform === "linkedin" ? teaching : [])]);
  const base = {
    negTitle,
    negStack: compileTerms(prefs.exclude_keywords),
    pos: compileTerms(prefs.include_keywords) ?? (platform === "linkedin" ? rolePositive(prefs.desired_roles) : null),
    spam: compileTerms([...SPAM_COMPANIES, ...prefs.excluded_companies, ...(platform === "naukri" ? ["freelance", "freelancer"] : [])]),
    maxYears: prefs.max_years_required,
    minPay: perYear(prefs.min_salary, prefs.salary_period),
  };
  if (platform === "linkedin") {
    const roles = li.keywords?.length ? li.keywords : prefs.desired_roles.length ? prefs.desired_roles : [profile.current_title].filter(Boolean) as string[];
    return {
      ...base,
      searches: linkedinSearches(roles.slice(0, 12), li.within ?? defaultWithin(prefs.max_posting_age_hours)),
      location: profile.location_country ?? "India",
      geoId: LINKEDIN_GEO_IDS[(profile.location_country ?? "india").toLowerCase()] ?? null,
      agg: compileTerms(LINKEDIN_AGGREGATORS),
      stack: farStack(profile.skills).map((t) => [t.name, t.re]),
      noStack: excludedStacks(prefs.exclude_keywords).map((t) => t.name),
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
  extra: {
    overrides?: Record<string, string>;
    known?: string[];
    coverNote?: string | null;
    screen?: Record<string, unknown>;
    /** LinkedIn draft: how recent the jobs are and the keywords to search (default the user's roles). */
    linkedin?: { within?: PostedWithin; keywords?: string[] };
    /** Only one half of the config, for an engine that needs only that half (the LinkedIn
        draft screens, the LinkedIn apply answers); default both. */
    only?: "answers" | "screen";
  } = {}
) {
  const cfg = {
    u: d.userId.slice(0, 8),
    ...(extra.only === "screen" ? {} : answerPack(d, extra.overrides)),
    ...(extra.only === "answers" ? {} : { screen: { ...screening(d, platform, extra.linkedin), ...(extra.screen ?? {}) } }),
    ...(extra.known ? { known: extra.known } : {}),
    ...(extra.coverNote ? { coverNote: extra.coverNote } : {}),
  };
  // h identifies this exact config, so a cached engine with stale answers is reloaded.
  const h = createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 8);
  return { ...cfg, h };
}
