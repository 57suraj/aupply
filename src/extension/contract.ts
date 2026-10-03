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
