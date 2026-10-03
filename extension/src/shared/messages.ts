/**
 * Messages between the side panel, the service worker and the content script (section 11.11).
 * The service worker is the only part that talks to Aupply; the content script never sees a
 * token and never contacts Aupply; the side panel talks only to the service worker.
 */

import type {
  ApplyResult,
  DraftOrder,
  DraftSummary,
  Field,
  JdOrder,
  JobOrder,
  MeResponse,
  PostedWithin,
  RunMode,
  SearchOrder,
  TrackerOrder,
} from "../../../src/extension/contract";

// ---------------------------------------------------------------------------
// Run state (persisted in chrome.storage.session after every step)
// ---------------------------------------------------------------------------

export type Phase = "starting" | "tracker" | "drafting" | "applying" | "waiting" | "paused" | "ending" | "done";

/** What the runner does next when it is woken. */
export type Todo =
  | { do: "session_start" }
  | { do: "exec_tracker"; lease: TrackerOrder }
  | { do: "post_tracker"; lease: TrackerOrder; count: number | null }
  | { do: "draft_start" }
  | { do: "draft_next"; leaseId?: string; result?: unknown }
  | { do: "exec_draft"; order: SearchOrder | JdOrder }
  | { do: "apply_next" }
  | { do: "exec_job"; lease: JobOrder }
  | { do: "post_result"; lease: JobOrder; result: ApplyResult }
  | { do: "end"; reason: "done" | "user_stop" | "cap" | "blocked" | "error" | "stalled" };

/** What the runner is waiting for while it is not working. */
export type Pending =
  | { kind: "time"; until: number }
  | { kind: "ready"; cmd: Cmd; deadline: number; url: string }
  | { kind: "cmd"; cmd: Cmd; startedAt: number }
  | { kind: "user"; reason: string };

export interface Cmd {
  cmd_id: string;
  name: "tracker" | "search" | "jd" | "apply";
  args: unknown;
}

export interface RecentResult { id: string; title: string; company: string; result: string; at: string }

export interface RunState {
  runId: string;
  mode: RunMode;
  postedWithin: PostedWithin;
  plan: { draft: boolean; apply: boolean };
  phase: Phase;
  /** Plain words for the side panel ("Searching LinkedIn", "Waiting 38s (LinkedIn pacing)"). */
  status: string;
  draftId?: string;
  todo: Todo;
  pending?: Pending;
  stopRequested: boolean;
  counters: { sent: number; unconfirmed: number; skipped: number; failed: number; waiting: number };
  recent: RecentResult[];
  lastProgressAt: number;
  /** The end of the last job (the 30 second floor between jobs). */
  lastJobEndAt?: number;
  stalls: number;
  notLoadedStreak: number;
  slow: boolean;
  draftSummary?: DraftSummary;
  /** A click Aupply could not make (no debugger permission): shown in the side panel. */
  handoff?: { what: "typeahead" | "follow"; label: string; value?: string; until: number };
  /** Why the run ended or paused, in plain words. */
  message?: string;
  endSummary?: { counts: Record<string, number>; saved: number; provisional: number; trackerMismatch: boolean };
  /** The draft of this run has finished (its summary is in draftSummary). */
  draftDone?: boolean;
  /** Consecutive failed calls to Aupply (network, 5xx): retried, then the run ends. */
  errors?: number;
  /** What to do once the result being posted is recorded. */
  after?: { pause?: string; end?: "stalled" | "error" };
}

// ---------------------------------------------------------------------------
// Side panel <-> service worker
// ---------------------------------------------------------------------------

export interface UiState {
  connected: boolean;
  device: { id: string; name: string } | null;
  pairing: { user_code: string; verify_url: string; expires_at: string } | null;
  me: MeResponse | null;
  run: RunState | null;
  updateRequired: { min_version: string; download_url: string } | null;
  debuggerGranted: boolean;
  version: string;
  baseUrl: string;
  error: string | null;
}

export type PanelRequest =
  | { type: "state/get" }
  | { type: "auth/start"; deviceName?: string }
  | { type: "auth/poll" }
  | { type: "auth/cancel" }
  | { type: "auth/signout" }
  | { type: "me/refresh" }
  | { type: "run/start"; mode: RunMode; postedWithin: PostedWithin }
  | { type: "run/stop" }
  | { type: "run/resume" }
  | { type: "questions/list" }
  | { type: "questions/answer"; id: string; answer: string }
  | { type: "questions/dismiss"; id: string }
  | { type: "decisions/list" }
  | { type: "decisions/submit"; items: { id: string; keep: boolean }[] }
  | { type: "review/list" }
  | { type: "review/confirm"; id: string; answer?: string }
  | { type: "queue/list" }
  | { type: "queue/remove"; id: string }
  | { type: "setup/propose" }
  | { type: "setup/save"; body: unknown }
  | { type: "settings/rename"; name: string }
  | { type: "perm/debugger" }
  | { type: "log/copy" };

export type PanelResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export type SwBroadcast = { type: "state/changed"; state: UiState };

// ---------------------------------------------------------------------------
// Content script <-> service worker
// ---------------------------------------------------------------------------

export type ContentToSw =
  | { type: "cs/ready"; url: string; loggedIn: boolean; checkpoint: boolean; hidden: boolean }
  | { type: "cs/progress"; cmd_id: string; note?: string }
  | { type: "cs/answers"; cmd_id: string; lease_id: string; page: { progress: string; index: number }; company: string; fields: Field[] }
  | { type: "cs/clickRequest"; cmd_id: string; x: number; y: number; dpr: number }
  | { type: "cs/handoff"; cmd_id: string; what: "typeahead" | "follow"; label: string; value?: string; done?: boolean }
  | { type: "cs/done"; cmd_id: string; result: unknown };

export type SwToContent = { type: "cmd"; cmd_id: string; name: Cmd["name"]; args: unknown };

export type ReadyAnswer = { role: "worker" | "idle" };
export type AnswersReply = { ok: true; answers: import("../../../src/extension/contract").AnswersResponse } | { ok: false; error: string };
export type ClickReply = { ok: boolean; reason?: string };

export type { DraftOrder };
