/**
 * Build constants and the pacing floors (BUILD-INSTRUCTIONS.md section 11.8). The server sets
 * the pace; these are floors the extension keeps even if an answer asks for less. It may only
 * ever be slower. Never hitting a LinkedIn rate limit outranks speed (CLAUDE.md, priorities).
 */

export const FLOORS = {
  /** Between guest search requests. */
  searchGapMs: 1000,
  /** Between guest JD requests. */
  jdGapMs: 1500,
  /** After a job page loads (8 seconds once the run has seen a rate limit). */
  pageWaitMs: 6000,
  pageWaitSlowMs: 8000,
  /** Between jobs: Chrome alarms fire no sooner than 30 seconds. */
  betweenJobsMs: 30_000,
  /** Polls for the title, the apply control and the modal. */
  pollMs: 15_000,
  /** One job, start to finish. */
  jobMaxMs: 240_000,
} as const;

export const LIMITS = {
  /** Raw response bodies sent to the server are cut here. */
  maxHtml: 150_000,
  /** A content command with no progress for this long is stuck (the watchdog). */
  stallMs: 5 * 60_000,
  /** The content script reports progress this often during a command. */
  progressEveryMs: 15_000,
  /** How long a page may take to load and say ready. */
  readyTimeoutMs: 45_000,
  /** How long a form page waits for the server's answers. */
  answersTimeoutMs: 60_000,
  /** How long the user has to make a click Aupply could not make. */
  handoffMs: 3 * 60_000,
  heartbeatMs: 60_000,
  /** Waits up to this long run on a timer; longer ones on an alarm. */
  timerWaitMs: 20_000,
  logLines: 300,
  recentResults: 50,
} as const;
