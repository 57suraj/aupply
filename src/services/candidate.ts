/**
 * Candidate data: profile, work history, education, preferences.
 * Every function takes the authenticated user id and scopes every query by it
 * (the service-role client bypasses RLS).
 */

import type { z } from "zod";
import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { notFound, unwrap, unwrapMaybe } from "../lib/errors.js";
import type {
  EducationInput,
  EducationPatch,
  ExperienceInput,
  ExperiencePatch,
  PreferencesPatch,
  ProfilePatch,
} from "../domain/schemas.js";

const db = () => getSupabaseClient();

type WithMetadata<T> = Omit<T, "metadata"> & { metadata?: Json };
const asJson = <T extends { metadata?: Record<string, unknown> }>(v: T) => v as WithMetadata<T>;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getProfile(userId: string) {
  const profile = unwrapMaybe(await db().from("profiles").select("*").eq("id", userId).maybeSingle());
  if (!profile) throw notFound("Profile");
  return profile;
}

export async function updateProfile(userId: string, patch: z.infer<typeof ProfilePatch>) {
  const row = unwrapMaybe(
    await db()
      .from("profiles")
      .update(asJson(patch))
      .eq("id", userId)
      .select("*")
      .maybeSingle()
  );
  if (!row) throw notFound("Profile");
  return row;
}

/** Everything Claude needs to fill in an application form. */
export async function getCandidateProfile(userId: string) {
  const [profile, experiences, educations, facts] = await Promise.all([
    getProfile(userId),
    listExperiences(userId),
    listEducations(userId),
    db()
      .from("answers")
      .select("key, question, answer, status")
      .eq("user_id", userId)
      .not("key", "is", null)
      .order("key"),
  ]);
  return {
    profile,
    work_experiences: experiences,
    educations,
    canonical_answers: unwrap(facts),
  };
}

// ---------------------------------------------------------------------------
// Work experiences
// ---------------------------------------------------------------------------

export async function listExperiences(userId: string) {
  return unwrap(
    await db()
      .from("work_experiences")
      .select("*")
      .eq("user_id", userId)
      .order("sort_order")
      .order("start_date", { ascending: false, nullsFirst: true })
  );
}

export async function createExperience(userId: string, input: z.infer<typeof ExperienceInput>) {
  return unwrap(
    await db()
      .from("work_experiences")
      .insert({ ...asJson(input), user_id: userId })
      .select("*")
      .single()
  );
}

export async function updateExperience(userId: string, id: string, patch: z.infer<typeof ExperiencePatch>) {
  const row = unwrapMaybe(
    await db()
      .from("work_experiences")
      .update(asJson(patch))
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle()
  );
  if (!row) throw notFound("Work experience");
  return row;
}

export async function deleteExperience(userId: string, id: string) {
  const rows = unwrap(
    await db().from("work_experiences").delete().eq("id", id).eq("user_id", userId).select("id")
  );
  if (!rows.length) throw notFound("Work experience");
}

// ---------------------------------------------------------------------------
// Educations
// ---------------------------------------------------------------------------

export async function listEducations(userId: string) {
  return unwrap(
    await db()
      .from("educations")
      .select("*")
      .eq("user_id", userId)
      .order("sort_order")
      .order("end_date", { ascending: false, nullsFirst: true })
  );
}

export async function createEducation(userId: string, input: z.infer<typeof EducationInput>) {
  return unwrap(
    await db()
      .from("educations")
      .insert({ ...asJson(input), user_id: userId })
      .select("*")
      .single()
  );
}

export async function updateEducation(userId: string, id: string, patch: z.infer<typeof EducationPatch>) {
  const row = unwrapMaybe(
    await db()
      .from("educations")
      .update(asJson(patch))
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle()
  );
  if (!row) throw notFound("Education");
  return row;
}

export async function deleteEducation(userId: string, id: string) {
  const rows = unwrap(
    await db().from("educations").delete().eq("id", id).eq("user_id", userId).select("id")
  );
  if (!rows.length) throw notFound("Education");
}

// ---------------------------------------------------------------------------
// Preferences (1:1, row created at signup; upsert covers older accounts)
// ---------------------------------------------------------------------------

export async function getPreferences(userId: string) {
  const row = unwrapMaybe(await db().from("preferences").select("*").eq("user_id", userId).maybeSingle());
  if (row) return row;
  return unwrap(await db().from("preferences").insert({ user_id: userId }).select("*").single());
}

export async function updatePreferences(userId: string, patch: z.infer<typeof PreferencesPatch>) {
  const { rules, ...rest } = patch;
  return unwrap(
    await db()
      .from("preferences")
      .upsert({ ...rest, ...(rules ? { rules: rules as Json } : {}), user_id: userId }, { onConflict: "user_id" })
      .select("*")
      .single()
  );
}

// ---------------------------------------------------------------------------
// Whole-profile save (MCP update_profile): one call to onboard from a resume.
// A list passed for experiences or educations replaces the stored list.
// ---------------------------------------------------------------------------

export async function saveProfile(
  userId: string,
  input: {
    profile?: z.infer<typeof ProfilePatch>;
    preferences?: z.infer<typeof PreferencesPatch>;
    experiences?: z.infer<typeof ExperienceInput>[];
    educations?: z.infer<typeof EducationInput>[];
  }
) {
  const saved: string[] = [];
  if (input.profile && Object.keys(input.profile).length) {
    await updateProfile(userId, input.profile);
    saved.push(...Object.keys(input.profile).map((k) => `profile.${k}`));
  }
  if (input.preferences && Object.keys(input.preferences).length) {
    await updatePreferences(userId, input.preferences);
    saved.push(...Object.keys(input.preferences).map((k) => `preferences.${k}`));
  }
  for (const [table, rows] of [
    ["work_experiences", input.experiences],
    ["educations", input.educations],
  ] as const) {
    if (!rows) continue;
    unwrap(await db().from(table).delete().eq("user_id", userId).select("id"));
    if (rows.length) {
      unwrap(
        await db()
          .from(table)
          .insert(rows.map((r, i) => ({ ...asJson(r), sort_order: r.sort_order ?? i, user_id: userId })) as never, { defaultToNull: false })
          .select("id")
      );
    }
    saved.push(`${table} (${rows.length})`);
  }
  return { saved, missing: setupGaps(await getProfile(userId), await getPreferences(userId)) };
}

type ProfileRow = Awaited<ReturnType<typeof getProfile>>;
type PreferencesRow = Awaited<ReturnType<typeof getPreferences>>;

/** Facts the apply scripts need before a first run; each gap means a stop mid-form. */
export function setupGaps(p: ProfileRow, pr: PreferencesRow): string[] {
  const gaps: [boolean, string][] = [
    [!pr.desired_roles.length && !p.current_title, "preferences.desired_roles (what to search for)"],
    [!p.full_name, "profile.full_name"],
    [!p.phone, "profile.phone"],
    [!p.email, "profile.email"],
    [!p.location_city || !p.location_country, "profile.location_city / location_country"],
    [p.years_experience == null, "profile.years_experience"],
    [!p.skills.length, "profile.skills (drafts ask about every stack not listed here)"],
    [!p.current_title, "profile.current_title"],
    [p.notice_period_days == null, "profile.notice_period_days"],
    [p.current_salary == null, "profile.current_salary (+ currency, period)"],
    [pr.expected_salary == null, "preferences.expected_salary"],
    [pr.max_years_required == null, "preferences.max_years_required (skip jobs asking for more)"],
  ];
  return gaps.filter(([missing]) => missing).map(([, name]) => name);
}
