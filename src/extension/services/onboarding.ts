/**
 * Onboarding from the side panel (section 10.8): propose profile values from the default
 * resume (nothing saved), then save what the user confirmed. Saving goes through the MCP's
 * own schemas and saveProfile, so both channels store a profile the same way.
 *
 * Email and phone are read from the resume by regex on the server and never sent to the AI;
 * the rest of the resume goes to the smart tier with them removed. No AI available: the
 * proposal carries what the regex found and everything else is asked.
 */

import { z } from "zod";
import { EducationInput, ExperienceInput, PreferencesPatch, ProfilePatch } from "../../domain/schemas.js";
import { getPreferences, getProfile, saveProfile, setupGaps } from "../../services/candidate.js";
import { pickResume } from "../../services/resumes.js";
import { AiBudgetExceeded, AiUnavailable, callJson } from "../ai/client.js";
import { extractEmail, extractPhone, redactEmailsPhones } from "../ai/prompts/common.js";
import * as OB from "../ai/prompts/onboarding.js";
import type { OnboardingProposeResponse, OnboardingSaveResponse } from "../contract.js";
import { ExtError } from "../server/http.js";

const SaveInput = z.object({
  profile: ProfilePatch.optional(),
  preferences: PreferencesPatch.optional(),
  experiences: z.array(ExperienceInput).max(30).optional(),
  educations: z.array(EducationInput).max(15).optional(),
});

export async function saveOnboarding(userId: string, body: unknown): Promise<OnboardingSaveResponse> {
  const input = SaveInput.parse(body);
  return saveProfile(userId, input);
}

/** Keep only the fields a schema accepts (a model's odd value is dropped, not fatal). */
function keepValid<T extends z.ZodTypeAny>(schema: T, value: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    if (schema.safeParse({ [k]: v }).success) out[k] = v;
  }
  return out;
}

export async function proposeOnboarding(userId: string): Promise<OnboardingProposeResponse> {
  let resume;
  try {
    resume = await pickResume(userId, {});
  } catch {
    resume = null;
  }
  const text = (resume?.content ?? "").trim();
  if (!text) throw new ExtError(404, "not_found", "Upload your resume on the Aupply dashboard first, then try again.");

  const email = extractEmail(text);
  const phone = extractPhone(text);
  const scrubbed = redactEmailsPhones(text);

  let ai: OB.Onboarding | null = null;
  try {
    ai = (await callJson({ userId, tier: "smart", purpose: "onboarding", system: OB.SYSTEM, user: OB.user(scrubbed), schema: OB.Onboarding, maxTokens: 3000 })).data;
  } catch (err) {
    if (!(err instanceof AiUnavailable || err instanceof AiBudgetExceeded)) throw err;
  }

  const links = Object.fromEntries(Object.entries(ai?.profile.links ?? {}).filter(([, v]) => Boolean(v))) as Record<string, string>;
  const profile = keepValid(ProfilePatch, {
    ...(ai ? { ...ai.profile, links: Object.keys(links).length ? links : null } : {}),
    email,
    phone,
  });
  const preferences = keepValid(PreferencesPatch, { desired_roles: ai?.preferences.desired_roles ?? [] });
  const experiences = (ai?.experiences ?? [])
    .map((e) => keepValid(ExperienceInput, e))
    .filter((e) => ExperienceInput.safeParse(e).success);
  const educations = (ai?.educations ?? [])
    .map((e) => keepValid(EducationInput, e))
    .filter((e) => EducationInput.safeParse(e).success);

  // What is still missing once the proposal is accepted: the gaps a resume cannot fill.
  const [current, prefs] = await Promise.all([getProfile(userId), getPreferences(userId)]);
  const fill = <T extends object>(row: T, patch: Record<string, unknown>) =>
    ({ ...row, ...Object.fromEntries(Object.entries(patch).filter(([k]) => (row as Record<string, unknown>)[k] == null || (Array.isArray((row as Record<string, unknown>)[k]) && !((row as Record<string, unknown>)[k] as unknown[]).length))) }) as T;
  const toAsk = setupGaps(fill(current, profile), fill(prefs, preferences));

  return {
    proposal: { profile, preferences, experiences, educations },
    from_resume: [...Object.keys(profile).map((k) => `profile.${k}`), ...Object.keys(preferences).map((k) => `preferences.${k}`)],
    to_ask: toAsk,
    ai_used: Boolean(ai),
  };
}
