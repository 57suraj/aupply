/**
 * Domain enums and input schemas shared by the MCP tools and the REST API.
 *
 * The enums MUST match the CHECK constraints in supabase/migrations. When a
 * migration adds a value, add it here in the same change.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (mirror DB CHECK constraints)
// ---------------------------------------------------------------------------

export const APPLICATION_STATUSES = [
  "discovered", "lead", "skipped", "parked", "applied", "unconfirmed", "failed", "closed",
] as const;

export const APPLICATION_STAGES = [
  "none", "acknowledged", "screening", "assessment", "interview",
  "offer", "hired", "rejected", "withdrawn", "ghosted",
] as const;

export const EVENT_TYPES = [
  "acknowledged", "screening", "assessment", "interview", "offer",
  "hired", "rejected", "withdrawn", "ghosted", "info_request", "message", "note",
] as const;

export const WORK_MODES = ["remote", "hybrid", "onsite"] as const;
export const PAY_PERIODS = ["year", "month", "hour"] as const;
export const ANSWER_STATUSES = ["confirmed", "provisional"] as const;

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores only");
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. INR");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().int().min(0);
const years = z.number().min(0).max(80);
const stringList = (maxItems: number, maxLen = 200) => z.array(text(maxLen)).max(maxItems);
const metadata = z.record(z.unknown());
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA time zone");

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const ProfilePatch = z
  .object({
    email: z.string().trim().email().nullable(),
    full_name: optionalText(200),
    preferred_name: optionalText(100),
    phone: optionalText(40),
    headline: optionalText(300),
    summary: optionalText(5000),
    location_city: optionalText(120),
    location_region: optionalText(120),
    location_country: optionalText(120),
    timezone: timezone.nullable(),
    links: z.record(text(500)),
    current_title: optionalText(200),
    current_company: optionalText(200),
    years_experience: years.nullable(),
    current_salary: money.nullable(),
    current_salary_currency: currency.nullable(),
    current_salary_period: z.enum(PAY_PERIODS),
    notice_period_days: z.number().int().min(0).max(365).nullable(),
    earliest_start_date: isoDate.nullable(),
    skills: stringList(300, 100),
    languages: stringList(50, 100),
    metadata,
  })
  .partial()
  .strict();

export const ExperienceInput = z
  .object({
    company: text(200).min(1),
    title: text(200).min(1),
    employment_type: optionalText(50),
    location: optionalText(200),
    start_date: isoDate.nullable().optional(),
    end_date: isoDate.nullable().optional(),
    is_current: z.boolean().optional(),
    description: optionalText(5000),
    highlights: stringList(50, 1000).optional(),
    skills: stringList(100, 100).optional(),
    sort_order: z.number().int().optional(),
    metadata: metadata.optional(),
  })
  .strict();
export const ExperiencePatch = ExperienceInput.partial().strict();

export const EducationInput = z
  .object({
    institution: text(200).min(1),
    degree: optionalText(200),
    field_of_study: optionalText(200),
    start_date: isoDate.nullable().optional(),
    end_date: isoDate.nullable().optional(),
    grade: optionalText(50),
    grade_scale: optionalText(50),
    description: optionalText(5000),
    sort_order: z.number().int().optional(),
    metadata: metadata.optional(),
  })
  .strict();
export const EducationPatch = EducationInput.partial().strict();

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const PreferencesPatch = z
  .object({
    desired_roles: stringList(50),
    seniority_levels: stringList(20, 50),
    desired_locations: stringList(50),
    work_modes: z.array(z.enum(WORK_MODES)).max(3),
    employment_types: stringList(10, 50),
    willing_to_relocate: z.boolean().nullable(),
    min_salary: money.nullable(),
    expected_salary: money.nullable(),
    salary_currency: currency.nullable(),
    salary_period: z.enum(PAY_PERIODS),
    max_years_required: years.nullable(),
    include_keywords: stringList(100, 100),
    exclude_keywords: stringList(200, 100),
    preferred_companies: stringList(200),
    excluded_companies: stringList(500),
    platforms: z.array(slug).max(30),
    max_posting_age_hours: z.number().int().positive().max(24 * 365).nullable(),
    daily_application_limit: z.number().int().positive().max(1000).nullable(),
    notes: optionalText(10000),
    rules: metadata,
  })
  .partial()
  .strict();

// ---------------------------------------------------------------------------
// Resumes
// ---------------------------------------------------------------------------

export const ResumeInput = z
  .object({
    label: text(100).min(1).optional(),
    content: optionalText(200_000),
    structured: metadata.nullable().optional(),
    is_default: z.boolean().optional(),
    metadata: metadata.optional(),
  })
  .strict();
export const ResumePatch = ResumeInput.extend({ archived: z.boolean().optional() }).strict();

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export const AnswerInput = z
  .object({
    question: text(2000).min(1),
    answer: text(20000).min(1),
    key: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]+$/).nullable().optional(),
    category: optionalText(50),
    tags: stringList(20, 50).optional(),
    status: z.enum(ANSWER_STATUSES).optional(),
    metadata: metadata.optional(),
  })
  .strict();
export const AnswerPatch = AnswerInput.partial().strict();

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export const QuestionLogInput = z.object({
  question: text(2000).min(1),
  answer: optionalText(20000),
  field_type: optionalText(30),
  options: z.array(text(500)).max(200).nullable().optional(),
  answer_id: z.string().uuid().nullable().optional(),
});

/** Shared shape of a job/application record (no user_id, no derived fields). */
export const ApplicationFields = z.object({
  platform: slug,
  external_id: optionalText(200),
  job_url: optionalText(2000),
  company_name: text(300).min(1),
  job_title: text(300).min(1),
  location: optionalText(300),
  work_mode: z.enum(WORK_MODES).nullable().optional(),
  employment_type: optionalText(50),
  salary_min: money.nullable().optional(),
  salary_max: money.nullable().optional(),
  salary_currency: currency.nullable().optional(),
  salary_period: z.enum(PAY_PERIODS).nullable().optional(),
  salary_text: optionalText(300),
  experience_min_years: years.nullable().optional(),
  experience_max_years: years.nullable().optional(),
  job_description: optionalText(50_000),
  posted_at: isoDateTime.nullable().optional(),
  status: z.enum(APPLICATION_STATUSES),
  status_reason: optionalText(2000),
  applied_at: isoDateTime.nullable().optional(),
  match_score: z.number().min(0).max(100).nullable().optional(),
  resume_id: z.string().uuid().nullable().optional(),
  run_id: z.string().uuid().nullable().optional(),
  cover_note: optionalText(20000),
  source: optionalText(50),
  notes: optionalText(10000),
  metadata: metadata.optional(),
});

export const ApplicationInput = ApplicationFields.extend({
  questions: z.array(QuestionLogInput).max(200).optional(),
}).strict();

export const ApplicationPatch = ApplicationFields.partial().strict();

export const ApplicationListQuery = z.object({
  status: z.array(z.enum(APPLICATION_STATUSES)).optional(),
  stage: z.array(z.enum(APPLICATION_STAGES)).optional(),
  platform: slug.optional(),
  q: z.string().trim().max(200).optional(),
  since: isoDateTime.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ApplicationListQuery = z.infer<typeof ApplicationListQuery>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EventFields = z.object({
  type: z.enum(EVENT_TYPES),
  occurred_at: isoDateTime.optional(),
  source: slug.optional(),
  external_ref: optionalText(500),
  company_name: optionalText(300),
  subject: optionalText(1000),
  detail: optionalText(20000),
  action_required: z.boolean().optional(),
  action_due_at: isoDateTime.nullable().optional(),
  metadata: metadata.optional(),
});

/** An event may name its application directly, by platform job id, or by company. */
export const EventInput = EventFields.extend({
  application_id: z.string().uuid().optional(),
  platform: slug.optional(),
  external_id: z.string().trim().max(200).optional(),
}).strict();

export const EventPatch = EventFields.partial()
  .extend({ action_done: z.boolean().optional() })
  .strict();

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RunInput = z
  .object({
    run_id: z.string().uuid().optional(),
    client: optionalText(50),
    summary: optionalText(20000),
    stats: metadata.optional(),
    ended: z.boolean().optional(),
    metadata: metadata.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Automation (platform tools). Engine output is forwarded as-is, so these accept the
// engines' short keys (t = title, co = company, ...).
// ---------------------------------------------------------------------------

export const SCRIPTED_PLATFORMS = ["linkedin", "naukri", "wellfound", "indeed"] as const;

const short = (max: number) => z.string().max(max).optional();

export const DraftJob = z
  .object({
    id: z.string().min(1).max(300).describe("Job id or URL, as the script returned it."),
    t: short(300), co: short(300), loc: short(300), w: short(10),
    agg: z.number().optional(), minY: z.number().optional(), yu: z.number().optional(),
    lvl: short(60), pay: z.number().optional(), sm: z.array(z.string().max(60)).max(40).optional(),
    s: short(200), ye: z.number().nullable().optional(), sal: short(120), ex: short(60),
  })
  .passthrough();

export const QueueJobsInput = z
  .object({
    platform: z.enum(SCRIPTED_PLATFORMS),
    source: z.enum(["sweep", "alert_email", "connector", "link", "manual"]).default("sweep"),
    run_id: z.string().uuid().optional(),
    jobs: z.array(DraftJob).max(300).default([]).describe("The script's kept jobs (`keep` or `jobs`), passed as-is."),
    skipped: z
      .array(z.object({ id: z.string().min(1).max(300), r: z.string().max(60), t: short(300), co: short(300) }).passthrough())
      .max(500)
      .default([])
      .describe("The script's dropped jobs (`drop`), passed as-is, so no later draft screens them again."),
    decisions: z
      .array(z.object({ id: z.string().min(1).max(300), keep: z.boolean() }))
      .max(100)
      .optional()
      .describe("The user's answers to an earlier ask_user: keep or drop each job."),
    stop: z.string().max(100).optional().describe("The script's `stop`, if it reported one."),
    tracker: z.number().int().nullable().optional().describe("LinkedIn: the Applied count the sweep read."),
  })
  .strict();

export const EngineResult = z
  .object({
    id: z.string().max(300).optional(),
    r: z.string().max(40),
    a: z.string().max(20).optional(),
    t: short(300), co: short(300),
    need: z.array(z.string().max(400)).max(20).optional(),
    qa: z.array(z.tuple([z.string().max(300), z.string().max(300)])).max(30).optional(),
    n: z.number().optional(), y: z.number().optional(), code: z.number().optional(), why: short(60),
  })
  .passthrough();

export const ReportResultsInput = z
  .object({
    platform: z.enum(SCRIPTED_PLATFORMS),
    run_id: z.string().uuid().optional(),
    engine: short(40).describe("The `engine` id from the tool that issued the script."),
    results: z.array(EngineResult).min(1).max(100).describe("The `new` items from status()/wait(), passed as-is."),
    tracker: z
      .object({ before: z.number().nullable().optional(), after: z.number().nullable().optional() })
      .passthrough()
      .optional()
      .describe("LinkedIn: status().tracker once the queue is done."),
  })
  .strict();

export const ApplyJobsInput = {
  jobs: z.array(z.string().min(1).max(500)).max(50).optional().describe("Job ids or links, in any mix."),
  from_queue: z.boolean().optional().describe("Apply to the drafted queue, best first."),
  limit: z.number().int().min(1).max(50).optional(),
  answers: z
    .record(z.string().max(2000))
    .optional()
    .describe("Question -> answer, for questions a previous run returned as NEEDS_INPUT (save them with save_answer too)."),
  engine_loaded: z.string().max(40).optional().describe("The engine id already loaded in this page, to skip re-sending the script."),
};
