/**
 * Tool: update_profile
 *
 * Saves the user's profile, preferences, work history and education in one call, so
 * Claude can onboard a user from their resume. Lists replace what is stored.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EducationInput, ExperienceInput, PreferencesPatch, ProfilePatch } from "../../domain/schemas.js";
import { saveProfile } from "../../services/candidate.js";
import { IDEMPOTENT_WRITE, run } from "../toolkit.js";

export function registerUpdateProfile(server: McpServer): void {
  server.registerTool(
    "update_profile",
    {
      title: "Update profile and preferences",
      description:
        "Save the user's profile, job preferences, work history and education. The apply scripts fill forms from " +
        "these values, so save only what the user stated or confirmed: propose values read from get_resume, ask " +
        "about anything the resume doesn't say, never guess personal facts. Only the fields passed change. " +
        "experiences and educations, when passed, replace the stored lists (send the full list). Money is whole " +
        "units per salary_period (e.g. 1200000 INR per year). Returns the fields saved and what is still missing.",
      inputSchema: {
        profile: ProfilePatch.optional(),
        preferences: PreferencesPatch.optional(),
        experiences: z.array(ExperienceInput).max(30).optional().describe("Full work history, newest first."),
        educations: z.array(EducationInput).max(10).optional(),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async (args, extra) => run(extra, (userId) => saveProfile(userId, args))
  );
}
