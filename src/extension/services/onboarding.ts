/**
 * Onboarding from the side panel (section 10.8): propose profile values from the default
 * resume (nothing saved), then save what the user confirmed. Saving goes through the MCP's
 * own schemas and saveProfile, so both channels store a profile the same way.
 */

import { z } from "zod";
import { EducationInput, ExperienceInput, PreferencesPatch, ProfilePatch } from "../../domain/schemas.js";
import { saveProfile } from "../../services/candidate.js";
import type { OnboardingSaveResponse } from "../contract.js";

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
