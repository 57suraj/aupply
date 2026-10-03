/**
 * The AI resume profile: one structured profile per resume version (sha256 of its text),
 * cached in ext_resume_profiles. The resume used is the one the MCP picks (pickResume: the
 * default, else the newest non-archived). No resume text, or no AI: a profile built from the
 * profile fields alone (basis 'profile', not cached).
 */

import { createHash } from "node:crypto";
import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { unwrapMaybe } from "../../lib/errors.js";
import { excludedStacks, rulesOf, type UserData } from "../../platforms/config.js";
import { pickResume } from "../../services/resumes.js";
import { AiBudgetExceeded, AiUnavailable, callJson } from "../ai/client.js";
import type { Candidate } from "../ai/prompts/fit.js";
import * as RP from "../ai/prompts/resumeProfile.js";
import { uid8 } from "../server/http.js";

const db = () => getSupabaseClient();

export interface ProfileResult {
  profile: RP.ResumeProfile;
  basis: "resume" | "profile";
  model: string | null;
  resumeText: string;
}

const DEGREE: [RegExp, RP.ResumeProfile["education_level"]][] = [
  [/ph\.?\s?d|doctor/i, "phd"],
  [/master|m\.?\s?tech|m\.?\s?s\b|m\.?\s?sc|mba|mca|m\.?\s?e\b/i, "master"],
  [/bachelor|b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|bca|\bba\b|undergrad/i, "bachelor"],
];

function fromProfileFields(d: UserData): RP.ResumeProfile {
  const p = d.profile;
  const level = d.educations.map((e) => DEGREE.find(([re]) => re.test(e.degree ?? ""))?.[1]).find(Boolean) ?? "unknown";
  return {
    headline: p.headline ?? p.current_title,
    total_years: p.years_experience,
    recent_titles: [p.current_title, ...d.experiences.map((e) => e.title)].filter((t, i, a): t is string => Boolean(t) && a.indexOf(t) === i).slice(0, 5),
    skills: p.skills.slice(0, 40).map((name) => ({ name, years: null, strength: "working" as const })),
    domains: [],
    education_level: level,
    highlights: [],
  };
}

async function currentResume(userId: string) {
  try {
    return await pickResume(userId, {});
  } catch {
    return null; // no resume uploaded
  }
}

export async function resumeProfileFor(d: UserData): Promise<ProfileResult> {
  const resume = await currentResume(d.userId);
  const text = resume?.archived_at ? "" : (resume?.content ?? "").trim();
  if (!resume || !text) return { profile: fromProfileFields(d), basis: "profile", model: null, resumeText: "" };
  const hash = createHash("sha256").update(text).digest("hex");
  const cached = unwrapMaybe(
    await db()
      .from("ext_resume_profiles")
      .select("profile, model, prompt_version")
      .eq("user_id", d.userId)
      .eq("resume_id", resume.id)
      .eq("content_hash", hash)
      .maybeSingle()
  );
  if (cached && cached.prompt_version === RP.PROMPT_VERSION) {
    const parsed = RP.ResumeProfile.safeParse(cached.profile);
    if (parsed.success) return { profile: parsed.data, basis: "resume", model: cached.model, resumeText: text };
  }
  try {
    const { data, model } = await callJson({
      userId: d.userId, tier: "fast", purpose: "resume_profile", system: RP.SYSTEM,
      user: RP.user({ years: d.profile.years_experience, title: d.profile.current_title, skills: d.profile.skills, resume: text }),
      schema: RP.ResumeProfile, maxTokens: 2000,
    });
    const { error } = await db()
      .from("ext_resume_profiles")
      .upsert(
        { user_id: d.userId, resume_id: resume.id, content_hash: hash, profile: data as unknown as Json, model, prompt_version: RP.PROMPT_VERSION },
        { onConflict: "resume_id,content_hash" }
      );
    if (error) console.error(`[ext] resume profile not cached user=${uid8(d.userId)}`, error.message);
    return { profile: data, basis: "resume", model, resumeText: text };
  } catch (err) {
    if (!(err instanceof AiUnavailable || err instanceof AiBudgetExceeded)) throw err;
    return { profile: fromProfileFields(d), basis: "profile", model: null, resumeText: text };
  }
}

/** The candidate block of the fit prompt (B.3): the same bytes for every job of a draft. */
export function candidateBlock(d: UserData, rp: RP.ResumeProfile): Candidate {
  const { profile: p, prefs } = d;
  const skills = [...new Set([...p.skills, ...rp.skills.filter((s) => s.strength !== "exposure").map((s) => s.name)])];
  return {
    target_roles: prefs.desired_roles.length ? prefs.desired_roles : ([p.current_title].filter(Boolean) as string[]),
    years: p.years_experience ?? rp.total_years,
    skills: skills.slice(0, 60),
    recent_titles: rp.recent_titles,
    domains: rp.domains,
    education: rp.education_level,
    work_modes: prefs.work_modes,
    locations: [p.location_city, ...prefs.desired_locations].filter((x, i, a): x is string => Boolean(x) && a.indexOf(x) === i),
    relocate: prefs.willing_to_relocate,
    employment_types: prefs.employment_types,
    excluded_stacks: excludedStacks(prefs.exclude_keywords).map((t) => t.name),
  };
}

/** preferences.rules.ext: min_fit (default 50) and draft_target (default 40). */
export function extRules(d: UserData) {
  const ext = (rulesOf(d.prefs).ext ?? {}) as Record<string, unknown>;
  return {
    minFit: Number(ext.min_fit) || 50,
    draftTarget: Number(ext.draft_target) || 0,
  };
}
