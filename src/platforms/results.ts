/**
 * Engine result -> application status and what Claude does next. The retry and stop
 * rules applix kept in prose (retry a 406 once, NO_MODAL, the cap) live here.
 */

type Status = "applied" | "unconfirmed" | "parked" | "skipped" | "lead" | "closed" | "failed";

export type Next = "continue" | "retry" | "ask_user" | "handoff" | "drive_again";

export interface Outcome {
  status: Status | null; // null: leave the row as it is (still queued)
  reason?: string;
  next: Next;
  /** Rate-limit sign: block the scope for `minutes`, or until the end of the user's day. */
  block?: { scope: string; minutes?: number; endOfDay?: boolean; reason: string };
  retryable?: boolean;
}

const done = (status: Status, reason?: string): Outcome => ({ status, reason, next: "continue" });

// Failures worth exactly one retry; the second one is final.
const RETRYABLE = new Set([
  "NO_MODAL", "STALL", "NO_BUTTON", "TITLE_MISMATCH", "ERR", "REJECTED", "NO_ANSWERABLE_QUESTION",
  "CLICK_FAILED", "NO_INPUT", "TYPE_FAILED", "MAX_STEPS", "NO_RESULT", "NO_SEND", "STUCK",
]);

export function mapResult(platform: string, rec: { r: string; n?: number; why?: string; need?: string[]; y?: number }, priorFailures: number): Outcome {
  const r = rec.r;
  switch (r) {
    case "SENT":
    case "APPLIED":
      return done("applied");
    case "UNCONFIRMED":
    case "UNCONF":
      return done("unconfirmed", "submitted; not confirmed by the platform yet");
    case "ALREADY_APPLIED":
    case "ALREADY":
      return done("applied", "already applied (seen on the platform)");
    case "READY_FOR_CAPTCHA":
    case "READY_TO_SUBMIT":
      return done("parked", "waiting for you to tick the CAPTCHA and press Submit in the open tab");
    case "CLOSED":
      return done("closed", "no longer accepting applications");
    case "NO_EASY_APPLY":
      return done("skipped", "not Easy Apply");
    case "EXTERNAL":
    case "NO_INDEED_APPLY":
      return done("lead", "applies on the company site");
    case "NO_APPLY_BUTTON":
      return done("closed", "no apply control after 13s (dead listing)");
    case "NO_APPLY":
      return done("skipped", "no apply button");
    case "DUPLICATE_COMPANY":
      return done("skipped", "already applied to this company (Wellfound never opens a second modal)");
    case "SKIP_YEARS":
      return done("skipped", `asks for ${rec.y ?? "more"} years`);
    case "SKIP_LOWPAY":
      return done("skipped", "pay below your floor");
    case "SKIP_RELOCATION":
      return done("skipped", "on-site, relocation not allowed");
    case "BLOCKED_LOC":
      return done("skipped", "not accepting applications from your location");
    case "PROTECTED":
      return done("skipped", `asks for a fact Aupply never invents: ${(rec.need ?? []).join("; ").slice(0, 200)}`);
    case "NO_ANSWER":
      return done("skipped", `chatbot question left unanswered (${rec.why ?? "unknown"}); no application was created`);
    case "NEEDS_INPUT":
      return { status: null, next: "ask_user" };
    case "NEEDS_CLICK":
    case "FOLLOW_STUCK":
    case "NEEDS_DROPDOWN":
      return { status: null, next: "handoff" };
    case "NAVIGATED":
    case "CONTINUE":
      return { status: null, next: "drive_again" };
    case "DAILY_LIMIT":
      return { status: null, next: "continue", block: { scope: platform, endOfDay: true, reason: "LinkedIn daily Easy Apply limit reached" } };
    case "RATE_LIMITED":
      return (rec.n ?? 1) >= 2
        ? { status: null, next: "continue", block: { scope: platform, minutes: 180, reason: `${platform} rate limited twice this run` } }
        : { status: null, next: "continue" };
  }
  if (RETRYABLE.has(r)) {
    return priorFailures < 1
      ? { status: null, next: "retry", retryable: true }
      : { status: "failed", reason: `${r} twice`, next: "continue", retryable: true };
  }
  return { status: null, next: "continue", reason: `unknown result ${r}` };
}
