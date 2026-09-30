/**
 * Applications, their events (outcomes) and question logs.
 *
 * - One row per job, deduped on (user_id, platform, external_id).
 * - `status` is what we did; `stage` is derived by a DB trigger from events,
 *   so it is never written here.
 */

import type { z } from "zod";
import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { check, notFound, unwrap, unwrapMaybe } from "../lib/errors.js";
import { escapeLike, markAnswersUsed } from "./answers.js";
import type {
  ApplicationInput,
  ApplicationListQuery,
  ApplicationPatch,
  EventInput,
  EventPatch,
} from "../domain/schemas.js";

const db = () => getSupabaseClient();

/** List view: everything except the heavy JD / cover note text. */
const LIST_COLUMNS =
  "id, platform, external_id, job_url, company_name, job_title, location, work_mode, salary_min, salary_max, salary_currency, salary_period, salary_text, experience_min_years, experience_max_years, status, status_reason, stage, applied_at, posted_at, match_score, source, resume_id, run_id, created_at, updated_at";

// PostgREST .or() uses commas and parentheses as syntax; strip them from free text.
const orSafe = (value: string) => escapeLike(value.replace(/[,()]/g, " ").trim());

export async function listApplications(userId: string, query: ApplicationListQuery) {
  let q = db()
    .from("applications")
    .select(LIST_COLUMNS, { count: "exact" })
    .eq("user_id", userId);
  if (query.status?.length) q = q.in("status", query.status);
  if (query.stage?.length) q = q.in("stage", query.stage);
  if (query.platform) q = q.eq("platform", query.platform);
  if (query.since) q = q.gte("created_at", query.since);
  if (query.q) {
    const term = orSafe(query.q);
    if (term) q = q.or(`company_name.ilike.%${term}%,job_title.ilike.%${term}%`);
  }
  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);
  return { items: unwrap({ data, error }), total: count ?? 0 };
}

export async function getApplication(userId: string, id: string) {
  const [app, events, questions] = await Promise.all([
    db().from("applications").select("*").eq("id", id).eq("user_id", userId).maybeSingle(),
    db()
      .from("application_events")
      .select("*")
      .eq("application_id", id)
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false }),
    db()
      .from("application_questions")
      .select("*")
      .eq("application_id", id)
      .eq("user_id", userId)
      .order("created_at"),
  ]);
  const application = unwrapMaybe(app);
  if (!application) throw notFound("Application");
  return { ...application, events: unwrap(events), questions: unwrap(questions) };
}

/**
 * Create or update a job record. With an external_id it upserts on
 * (user_id, platform, external_id), updating only the fields provided.
 * Screening questions are appended to the application's question log.
 */
export async function logApplication(userId: string, input: z.infer<typeof ApplicationInput>) {
  const { questions, metadata, ...fields } = input;
  const row = { ...fields, ...(metadata ? { metadata: metadata as Json } : {}), user_id: userId };

  const application = unwrap(
    fields.external_id
      ? await db()
          .from("applications")
          .upsert(row, { onConflict: "user_id,platform,external_id" })
          .select(LIST_COLUMNS)
          .single()
      : await db().from("applications").insert(row).select(LIST_COLUMNS).single()
  );

  if (questions?.length) {
    check(
      await db()
        .from("application_questions")
        .insert(
          questions.map((q) => ({
            user_id: userId,
            application_id: application.id,
            question: q.question,
            answer: q.answer ?? null,
            field_type: q.field_type ?? null,
            options: (q.options ?? null) as Json,
            answer_id: q.answer_id ?? null,
          }))
        )
    );
    await markAnswersUsed(
      userId,
      questions.map((q) => q.answer_id).filter((id): id is string => Boolean(id))
    );
  }

  return { ...application, questions_logged: questions?.length ?? 0 };
}

export async function updateApplication(userId: string, id: string, patch: z.infer<typeof ApplicationPatch>) {
  const { metadata, ...fields } = patch;
  const row = unwrapMaybe(
    await db()
      .from("applications")
      .update({ ...fields, ...(metadata ? { metadata: metadata as Json } : {}) })
      .eq("id", id)
      .eq("user_id", userId)
      .select(LIST_COLUMNS)
      .maybeSingle()
  );
  if (!row) throw notFound("Application");
  return row;
}

export async function deleteApplication(userId: string, id: string) {
  const rows = unwrap(await db().from("applications").delete().eq("id", id).eq("user_id", userId).select("id"));
  if (!rows.length) throw notFound("Application");
}

/** Dedup check before applying: known job ids and companies already touched. */
export async function checkExisting(
  userId: string,
  params: { platform?: string; external_ids?: string[]; companies?: string[] }
) {
  return unwrap(
    await db().rpc("check_existing_applications", {
      p_user_id: userId,
      // The generated type says string, but the function treats NULL as "any platform".
      p_platform: (params.platform ?? null) as string,
      p_external_ids: params.external_ids ?? [],
      p_companies: params.companies ?? [],
    })
  );
}

export async function getStats(userId: string) {
  const profile = unwrapMaybe(await db().from("profiles").select("timezone").eq("id", userId).maybeSingle());
  return unwrap(
    await db().rpc("application_stats", { p_user_id: userId, p_tz: profile?.timezone || "UTC" })
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Find the application an event refers to: by id, by platform job id, or by company. */
async function resolveApplication(
  userId: string,
  ref: { application_id?: string; platform?: string; external_id?: string; company_name?: string | null }
): Promise<{ id: string; matched_by: string } | null> {
  if (ref.application_id) {
    const row = unwrapMaybe(
      await db().from("applications").select("id").eq("id", ref.application_id).eq("user_id", userId).maybeSingle()
    );
    if (!row) throw notFound("Application");
    return { id: row.id, matched_by: "application_id" };
  }
  if (ref.platform && ref.external_id) {
    const row = unwrapMaybe(
      await db()
        .from("applications")
        .select("id")
        .eq("user_id", userId)
        .eq("platform", ref.platform)
        .eq("external_id", ref.external_id)
        .maybeSingle()
    );
    if (row) return { id: row.id, matched_by: "platform_job_id" };
  }
  if (ref.company_name) {
    const row = unwrapMaybe(
      await db()
        .from("applications")
        .select("id")
        .eq("user_id", userId)
        .ilike("company_name", escapeLike(ref.company_name.trim()))
        .order("applied_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
    );
    if (row) return { id: row.id, matched_by: "company_name" };
  }
  return null;
}

export async function recordEvent(userId: string, input: z.infer<typeof EventInput>, defaultSource = "manual") {
  const { application_id, platform, external_id, metadata, ...fields } = input;
  const match = await resolveApplication(userId, {
    application_id,
    platform,
    external_id,
    company_name: fields.company_name,
  });

  const row = {
    ...fields,
    source: fields.source ?? defaultSource,
    ...(metadata ? { metadata: metadata as Json } : {}),
    application_id: match?.id ?? null,
    user_id: userId,
  };

  // Imports (e.g. Gmail) carry an external_ref: re-recording the same one is a no-op.
  let event;
  let duplicate = false;
  if (row.external_ref) {
    const inserted = unwrap(
      await db()
        .from("application_events")
        .upsert(row, { onConflict: "user_id,source,external_ref", ignoreDuplicates: true })
        .select("*")
    );
    event = inserted[0];
    if (!event) {
      duplicate = true;
      event = unwrap(
        await db()
          .from("application_events")
          .select("*")
          .eq("user_id", userId)
          .eq("source", row.source)
          .eq("external_ref", row.external_ref)
          .single()
      );
    }
  } else {
    event = unwrap(await db().from("application_events").insert(row).select("*").single());
  }

  let application = null;
  if (event.application_id) {
    application = unwrap(
      await db()
        .from("applications")
        .select("id, company_name, job_title, status, stage")
        .eq("id", event.application_id)
        .eq("user_id", userId)
        .single()
    );
  }
  return { event, duplicate, matched_by: match?.matched_by ?? null, application };
}

export async function updateEvent(userId: string, id: string, patch: z.infer<typeof EventPatch>) {
  const { metadata, ...fields } = patch;
  const row = unwrapMaybe(
    await db()
      .from("application_events")
      .update({ ...fields, ...(metadata ? { metadata: metadata as Json } : {}) })
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle()
  );
  if (!row) throw notFound("Event");
  return row;
}

export async function deleteEvent(userId: string, id: string) {
  const rows = unwrap(await db().from("application_events").delete().eq("id", id).eq("user_id", userId).select("id"));
  if (!rows.length) throw notFound("Event");
}

/** Everything waiting on the human, oldest-due first. */
export async function listPendingActions(userId: string) {
  return unwrap(
    await db()
      .from("application_events")
      .select("*, application:applications(id, company_name, job_title, platform, job_url, status, stage)")
      .eq("user_id", userId)
      .eq("action_required", true)
      .eq("action_done", false)
      .order("action_due_at", { ascending: true, nullsFirst: false })
      .order("occurred_at", { ascending: false })
  );
}

export async function listEvents(userId: string, filters: { pending?: boolean; limit?: number } = {}) {
  if (filters.pending) return listPendingActions(userId);
  return unwrap(
    await db()
      .from("application_events")
      .select("*, application:applications(id, company_name, job_title, platform)")
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false })
      .limit(Math.min(filters.limit ?? 100, 500))
  );
}
