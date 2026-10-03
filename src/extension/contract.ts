/**
 * The /ext/v1 contract: zod schemas and types for every request and response between the
 * Chrome extension (and the website's extension pages) and the extension's server.
 *
 * Imported by the server (src/extension/server) AND bundled into the extension, so this file
 * imports zod only: no node, no supabase, nothing from the MCP side. Requests are validated
 * on the server, responses in the extension. Unknown keys are stripped, never rejected, so a
 * newer server can add fields without breaking an older extension.
 */

import { z } from "zod";

export const API_PREFIX = "/ext/v1";
export const VERSION_HEADER = "X-Aupply-Ext-Version";

export const POSTED_WITHIN = ["1h", "24h", "1w"] as const;
export type PostedWithin = (typeof POSTED_WITHIN)[number];

// ---------------------------------------------------------------------------
// Errors: { error: { code, message, ...extra } }
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "invalid_request", "unauthorized", "token_expired", "device_revoked", "forbidden", "not_found",
  "conflict", "upgrade_required", "slow_down", "ai_unavailable", "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorBody = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      min_version: z.string().optional(),
      download_url: z.string().optional(),
      retry_after_s: z.number().optional(),
    })
    .passthrough(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  min_ext_version: z.string(),
  /** The server's self-check of the built engine definitions it uses. */
  engine: z.object({ ok: z.boolean(), fails: z.array(z.string()) }).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---------------------------------------------------------------------------
// Pairing and tokens (device-code flow, section 7.3)
// ---------------------------------------------------------------------------

const deviceName = z.string().trim().min(1).max(60);
const version = z.string().trim().max(20);
/** XXXX-XXXX from an alphabet without 0, 1, I and O. */
export const USER_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export const PairStartRequest = z.object({ device_name: deviceName, ext_version: version.optional() });
export type PairStartRequest = z.infer<typeof PairStartRequest>;
export const PairStartResponse = z.object({
  pair_id: z.string().uuid(),
  user_code: z.string().regex(USER_CODE),
  poll_secret: z.string(),
  verify_url: z.string(),
  expires_at: z.string(),
  interval_s: z.number(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

export const PairPollRequest = z.object({ pair_id: z.string().uuid(), poll_secret: z.string().min(16).max(200) });
export type PairPollRequest = z.infer<typeof PairPollRequest>;

export const Tokens = z.object({ access_token: z.string(), access_expires_at: z.string(), refresh_token: z.string() });
export type Tokens = z.infer<typeof Tokens>;

export const DeviceRef = z.object({ id: z.string().uuid(), name: z.string() });
export type DeviceRef = z.infer<typeof DeviceRef>;

export const PairPollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("approved"), device: DeviceRef, tokens: Tokens }),
]);
export type PairPollResponse = z.infer<typeof PairPollResponse>;

export const RefreshRequest = z.object({ refresh_token: z.string().min(16).max(200) });
export const RefreshResponse = Tokens;

// Website (Supabase session) side of pairing.
export const PAIR_STATUSES = ["pending", "approved", "denied"] as const;
export const WebPairInfo = z.object({
  device_name: z.string(),
  ext_version: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  status: z.enum(PAIR_STATUSES),
});
export type WebPairInfo = z.infer<typeof WebPairInfo>;
export const WebPairDecision = z.object({ approve: z.boolean() });
export const WebPairDecisionResponse = z.object({ status: z.enum(["approved", "denied"]), device: DeviceRef.optional() });
export type WebPairDecisionResponse = z.infer<typeof WebPairDecisionResponse>;

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const WebDevice = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ext_version: z.string().nullable(),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
});
export type WebDevice = z.infer<typeof WebDevice>;
export const WebDevicesResponse = z.array(WebDevice);

export const WebExtensionInfo = z.object({ latest_version: z.string(), min_version: z.string(), download_url: z.string() });
export type WebExtensionInfo = z.infer<typeof WebExtensionInfo>;

export const RenameDeviceRequest = z.object({ name: deviceName });
export const OkResponse = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// GET /me (section 7.5)
// ---------------------------------------------------------------------------

export const Cap = z.object({ cap: z.number(), used: z.number(), left: z.number() });
export type Cap = z.infer<typeof Cap>;
export const Block = z.object({ scope: z.string(), until: z.string().nullable(), reason: z.string().nullable() });
export type Block = z.infer<typeof Block>;

export const MeResponse = z.object({
  user: z.object({ email: z.string().nullable(), full_name: z.string().nullable() }),
  device: DeviceRef,
  setup_gaps: z.array(z.string()),
  linkedin: z.object({
    enabled: z.boolean(),
    cap: Cap,
    blocked: Block.nullable(),
    queue: z.object({ ready: z.number(), waiting_on_you: z.number(), decisions: z.number() }),
    posted_within_default: z.enum(POSTED_WITHIN),
    live_run: z.object({ run_id: z.string(), device_name: z.string().nullable(), phase: z.string().nullable(), this_device: z.boolean() }).nullable(),
  }),
  open_questions: z.number(),
  provisional_to_review: z.number(),
  versions: z.object({ latest: z.string(), min: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------------------------------------------------------------------------
// Onboarding (section 10.8). The server validates the payload with the MCP's own profile
// schemas; here it is only an object per part.
// ---------------------------------------------------------------------------

export const OnboardingSaveRequest = z.object({
  profile: z.record(z.unknown()).optional(),
  preferences: z.record(z.unknown()).optional(),
  experiences: z.array(z.record(z.unknown())).optional(),
  educations: z.array(z.record(z.unknown())).optional(),
});
export const OnboardingSaveResponse = z.object({ saved: z.array(z.string()), missing: z.array(z.string()) });
export type OnboardingSaveResponse = z.infer<typeof OnboardingSaveResponse>;

/** Proposed values (nothing saved yet), what came from the resume, and the gaps to ask about. */
export const OnboardingProposeResponse = z.object({
  proposal: z.object({
    profile: z.record(z.unknown()),
    preferences: z.record(z.unknown()),
    experiences: z.array(z.record(z.unknown())),
    educations: z.array(z.record(z.unknown())),
  }),
  from_resume: z.array(z.string()),
  to_ask: z.array(z.string()),
  ai_used: z.boolean(),
});
export type OnboardingProposeResponse = z.infer<typeof OnboardingProposeResponse>;

// ---------------------------------------------------------------------------
// Client log upload
// ---------------------------------------------------------------------------

export const EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;
export const ClientEvent = z.object({
  level: z.enum(EVENT_LEVELS),
  type: z.string().regex(/^[a-z0-9_.]+$/).max(60),
  run_id: z.string().uuid().optional(),
  data: z.record(z.unknown()).default({}),
  at: z.string().optional(),
});
export type ClientEvent = z.infer<typeof ClientEvent>;
export const EventsRequest = z.object({ events: z.array(ClientEvent).min(1).max(50) });

// ---------------------------------------------------------------------------
// Leases: every unit of LinkedIn work carries its lease and its time window
// ---------------------------------------------------------------------------

const LeaseTimes = { lease_id: z.string().uuid(), not_before: z.string(), expires_at: z.string() };

export const TrackerOrder = z.object({ type: z.literal("tracker"), ...LeaseTimes, url: z.string() });
export type TrackerOrder = z.infer<typeof TrackerOrder>;

export const WAIT_REASONS = ["rate_limited", "lease_busy", "claude_active", "blocked", "working"] as const;
export const WaitOrder = z.object({ type: z.literal("wait"), until: z.string(), reason: z.enum(WAIT_REASONS) });
export type WaitOrder = z.infer<typeof WaitOrder>;

export const DisabledAnswer = z.object({ type: z.literal("disabled"), message: z.string() });

// ---------------------------------------------------------------------------
// Sessions (section 7.6)
// ---------------------------------------------------------------------------

export const RUN_MODES = ["draft_apply", "apply", "draft"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const SessionStartRequest = z.object({
  posted_within: z.enum(POSTED_WITHIN).optional(),
  mode: z.enum(RUN_MODES),
  keywords: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
  target: z.number().int().min(5).max(60).optional(),
});
export type SessionStartRequest = z.infer<typeof SessionStartRequest>;

export const SessionStartResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    run_id: z.string().uuid(),
    posted_within: z.enum(POSTED_WITHIN),
    plan: z.object({ draft: z.boolean(), apply: z.boolean() }),
    cap: Cap,
    first: z.union([TrackerOrder, WaitOrder]),
  }),
  DisabledAnswer,
  z.object({ type: z.literal("not_subscribed"), message: z.string() }),
  z.object({ type: z.literal("setup_needed"), gaps: z.array(z.string()) }),
  z.object({ type: z.literal("busy"), reason: z.enum(["other_device", "claude_active"]), device_name: z.string().nullable().optional(), retry_at: z.string().optional() }),
  z.object({ type: z.literal("blocked"), scope: z.string(), until: z.string().nullable(), reason: z.string().nullable() }),
  z.object({ type: z.literal("cap_reached"), cap: Cap }),
]);
export type SessionStartResponse = z.infer<typeof SessionStartResponse>;

export const RUN_PHASES = ["starting", "tracker", "drafting", "applying", "waiting", "paused", "ending", "done"] as const;
export const HeartbeatRequest = z.object({
  run_id: z.string().uuid(),
  phase: z.enum(RUN_PHASES),
  hidden: z.boolean().optional(),
  job_id: z.string().max(20).optional(),
});
export const HeartbeatResponse = z.object({ ok: z.literal(true), stop: z.object({ reason: z.string() }).optional() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const END_REASONS = ["done", "user_stop", "cap", "blocked", "error", "stalled"] as const;
export const SessionEndRequest = z.object({ run_id: z.string().uuid(), reason: z.enum(END_REASONS) });
export const SessionEndResponse = z.object({
  counts: z.record(z.number()),
  saved_for_you: z.array(z.object({ id: z.string(), title: z.string(), company: z.string(), url: z.string().nullable() })),
  provisional_used: z.array(z.object({ question: z.string(), answer: z.string() })),
  tracker_mismatch: z.object({ moved: z.number(), recorded: z.number() }).nullable().optional(),
});
export type SessionEndResponse = z.infer<typeof SessionEndResponse>;

// ---------------------------------------------------------------------------
// Tracker (section 9.8)
// ---------------------------------------------------------------------------

export const TrackerRequest = z.object({ lease_id: z.string().uuid(), count: z.number().int().min(0).max(1_000_000).nullable() });
export const TrackerResponse = z.object({ cap: Cap });

// ---------------------------------------------------------------------------
// Draft (section 8)
// ---------------------------------------------------------------------------

export const SearchOrder = z.object({
  type: z.literal("search"),
  ...LeaseTimes,
  gap_ms: z.number(),
  pages: z.array(z.object({ url: z.string(), s: z.number().int(), page: z.number().int() })).max(5),
});
export type SearchOrder = z.infer<typeof SearchOrder>;
export const JdOrder = z.object({
  type: z.literal("jd"),
  ...LeaseTimes,
  gap_ms: z.number(),
  jobs: z.array(z.object({ id: z.string(), url: z.string() })).max(10),
});
export type JdOrder = z.infer<typeof JdOrder>;

export const DraftSummary = z.object({
  found: z.number(),
  title_dropped: z.record(z.number()),
  already_known: z.number(),
  read: z.number(),
  cached: z.number(),
  prescreen_dropped: z.record(z.number()),
  low_fit: z.number(),
  kept: z.number(),
  decisions: z.number(),
  stop: z.string().optional(),
});
export type DraftSummary = z.infer<typeof DraftSummary>;

export const DraftOrder = z.discriminatedUnion("type", [
  SearchOrder,
  JdOrder,
  WaitOrder,
  z.object({ type: z.literal("done"), summary: DraftSummary }),
  DisabledAnswer,
]);
export type DraftOrder = z.infer<typeof DraftOrder>;

export const DraftStartRequest = z.object({
  run_id: z.string().uuid(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
  target: z.number().int().min(5).max(60).optional(),
});
export const DraftStartResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    draft_id: z.string().uuid(),
    searching: z.object({ posted_within: z.enum(POSTED_WITHIN), roles: z.array(z.string()), windows: z.array(z.enum(POSTED_WITHIN)) }),
    order: DraftOrder,
  }),
  DisabledAnswer,
  z.object({ type: z.literal("blocked"), scope: z.string(), until: z.string().nullable(), reason: z.string().nullable() }),
  z.object({ type: z.literal("cap_reached"), cap: Cap }),
  z.object({ type: z.literal("no_roles"), message: z.string() }),
]);
export type DraftStartResponse = z.infer<typeof DraftStartResponse>;

/** Raw response bodies, capped at 150,000 characters each; the server parses them. */
export const MAX_HTML = 150_000;
const html = z.string().max(MAX_HTML + 1000);
export const SearchResult = z.object({
  pages: z.array(z.object({ url: z.string(), status: z.number().int(), html })).max(5),
  stopped: z.literal("rate_limited").optional(),
});
export const JdResult = z.object({
  jobs: z.array(z.object({ id: z.string().regex(/^\d{6,15}$/), status: z.number().int(), html })).max(10),
  stopped: z.literal("rate_limited").optional(),
});
export const DraftNextRequest = z.object({
  draft_id: z.string().uuid(),
  lease_id: z.string().uuid().optional(),
  result: z.union([SearchResult, JdResult]).optional(),
});
export type DraftNextRequest = z.infer<typeof DraftNextRequest>;

// ---------------------------------------------------------------------------
// Queue and stack decisions (sections 8.6, 8.7)
// ---------------------------------------------------------------------------

export const QueueItem = z.object({
  id: z.string().uuid(),
  job_id: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  score: z.number().nullable(),
  verdict: z.string().nullable(),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
  window: z.string().nullable(),
});
export type QueueItem = z.infer<typeof QueueItem>;
export const QueueResponse = z.object({ posted_within: z.enum(POSTED_WITHIN), items: z.array(QueueItem), waiting_on_you: z.number() });
export type QueueResponse = z.infer<typeof QueueResponse>;

export const DecisionItem = z.object({
  id: z.string().uuid(),
  job_id: z.string(),
  title: z.string(),
  company: z.string(),
  wants: z.array(z.string()),
  score: z.number().nullable(),
  reasons: z.array(z.string()),
});
export type DecisionItem = z.infer<typeof DecisionItem>;
export const DecisionsResponse = z.object({ items: z.array(DecisionItem) });
export const DecisionsRequest = z.object({ items: z.array(z.object({ id: z.string().uuid(), keep: z.boolean() })).min(1).max(100) });
export const DecisionsResult = z.object({ kept: z.number(), dropped: z.number() });

// ---------------------------------------------------------------------------
// Apply (section 9)
// ---------------------------------------------------------------------------

export const ApplyNextRequest = z.object({ run_id: z.string().uuid() });

export const JobOrder = z.object({
  type: z.literal("job"),
  ...LeaseTimes,
  job: z.object({ id: z.string(), url: z.string(), company: z.string(), title: z.string() }),
  page_wait_ms: z.number(),
  /** The user's country: a city typeahead suggestion must name it. */
  country: z.string().nullable(),
  attempt: z.number().int(),
  /** A visit to confirm an UNCONFIRMED submission (ALREADY_APPLIED settles it). */
  verify: z.boolean(),
});
export type JobOrder = z.infer<typeof JobOrder>;

export const ApplyNextResponse = z.discriminatedUnion("type", [
  JobOrder,
  TrackerOrder,
  WaitOrder,
  z.object({ type: z.literal("done"), reason: z.enum(["cap", "blocked", "queue_empty"]), until: z.string().nullable().optional(), waiting_on_you: z.number().optional() }),
  DisabledAnswer,
]);
export type ApplyNextResponse = z.infer<typeof ApplyNextResponse>;

/** What the content script reads from one form control (section 9.3). Only fields that still need a value. */
export const FIELD_KINDS = ["text", "textarea", "number", "select", "radio", "checkbox_group", "checkbox", "date_select", "typeahead"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const Field = z.object({
  fid: z.string().min(1).max(40),
  kind: z.enum(FIELD_KINDS),
  label: z.string().max(500),
  options: z.array(z.string().max(500)).max(200).optional(),
  option_values_empty: z.array(z.boolean()).max(200).optional(),
  required: z.boolean(),
  max_length: z.number().int().positive().optional(),
  date: z.object({ part: z.enum(["month", "year"]), index: z.number().int().min(0).max(3), context: z.enum(["education", "experience"]) }).optional(),
});
export type Field = z.infer<typeof Field>;

const fid = z.string().min(1).max(40);
export const Action = z.discriminatedUnion("do", [
  z.object({ fid, do: z.literal("set"), value: z.string() }),
  z.object({ fid, do: z.literal("choose"), index: z.number().int().min(0) }),
  z.object({ fid, do: z.literal("tick") }),
  z.object({ fid, do: z.literal("leave") }),
]);
export type Action = z.infer<typeof Action>;

export const AnswersRequest = z.object({
  lease_id: z.string().uuid(),
  page: z.object({ progress: z.string().max(40), index: z.number().int().min(0).max(30) }),
  company: z.string().max(200),
  fields: z.array(Field).max(60),
});
export type AnswersRequest = z.infer<typeof AnswersRequest>;
export const QUESTION_KINDS = ["needs_input", "protected"] as const;
export const AnswersResponse = z.object({
  verdict: z.enum(["fill", "protected", "needs_input"]),
  actions: z.array(Action),
  questions: z.array(z.object({ id: z.string().uuid(), question: z.string(), kind: z.enum(QUESTION_KINDS) })).optional(),
  ai_used: z.boolean(),
});
export type AnswersResponse = z.infer<typeof AnswersResponse>;

/** The MCP engine's codes plus the extension's own (section 9.5). */
export const RESULT_CODES = [
  "SENT", "UNCONFIRMED", "ALREADY_APPLIED", "CLOSED", "NO_EASY_APPLY", "NOT_LOADED", "NO_MODAL", "STALL", "NO_BUTTON",
  "TITLE_MISMATCH", "DAILY_LIMIT", "RATE_LIMITED", "ERR", "PROTECTED", "NEEDS_INPUT", "NEEDS_CLICK", "FOLLOW_STUCK",
  "CHECKPOINT", "LOGGED_OUT", "USER_NAVIGATED",
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];
export const ApplyResult = z.object({
  r: z.enum(RESULT_CODES),
  need: z.array(z.string().max(500)).max(20).optional(),
  errs: z.array(z.string().max(300)).max(10).optional(),
  trace: z.array(z.string().max(60)).max(30).optional(),
  hid: z.boolean().optional(),
  page: z.object({ title: z.string().max(300), company: z.string().max(200) }).optional(),
  e: z.string().max(300).optional(),
  question_ids: z.array(z.string().uuid()).max(20).optional(),
});
export type ApplyResult = z.infer<typeof ApplyResult>;
export const ApplyResultRequest = z.object({ lease_id: z.string().uuid(), result: ApplyResult });
export const NEXT_TYPES = ["continue", "stop", "pause"] as const;
export const ApplyResultResponse = z.object({
  status: z.string().nullable(),
  reason: z.string().nullable().optional(),
  cap: z.object({ left: z.number() }),
  next: z.object({ type: z.enum(NEXT_TYPES), reason: z.string().optional() }),
});
export type ApplyResultResponse = z.infer<typeof ApplyResultResponse>;

// ---------------------------------------------------------------------------
// Questions only the user can answer, and AI answers to review (sections 9.7, 9.9)
// ---------------------------------------------------------------------------

export const QuestionItem = z.object({
  id: z.string().uuid(),
  question: z.string(),
  kind: z.enum(QUESTION_KINDS),
  key: z.string().nullable(),
  field_type: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  waiting_count: z.number(),
  times_seen: z.number(),
});
export type QuestionItem = z.infer<typeof QuestionItem>;
export const QuestionsResponse = z.object({ items: z.array(QuestionItem) });
export const QuestionAnswerRequest = z.object({ answer: z.string().trim().min(1).max(2000) });
export const QuestionAnswerResponse = z.object({ ok: z.literal(true), released: z.number() });
export const QuestionDismissResponse = z.object({ ok: z.literal(true), skipped: z.number() });

export const ReviewItem = z.object({ id: z.string().uuid(), question: z.string(), answer: z.string(), created_at: z.string() });
export type ReviewItem = z.infer<typeof ReviewItem>;
export const ReviewResponse = z.object({ items: z.array(ReviewItem) });
export const ConfirmRequest = z.object({ answer: z.string().trim().min(1).max(5000).optional() });
