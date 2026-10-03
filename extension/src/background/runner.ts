/**
 * The run (section 11.5): one at a time, a state machine persisted in session storage after every
 * step, so a service worker stopped between events resumes exactly where it was. It never decides
 * what LinkedIn work to do: the server hands out every order and lease; the runner executes them
 * in the worker tab and posts the results.
 *
 *   start   session/start -> a tracker lease first
 *   draft   draft/start -> orders (search, jd, wait) -> draft/next with each result -> done
 *   apply   apply/next -> job | tracker | wait | done; a job's result -> apply/result -> next
 *   end     session/end -> counts
 *
 * Waits of 20 seconds or less run on a timer; longer ones on an alarm (Chrome fires alarms no
 * sooner than 30 seconds, which is why the floor between jobs is 30 seconds). Content command
 * results arrive as messages (cs/done), never as long-held responses. Every state change goes
 * through one lock.
 */

import {
  ApplyNextResponse,
  ApplyResult,
  ApplyResultResponse,
  DraftOrder,
  DraftStartResponse,
  HeartbeatResponse,
  JdResult,
  SearchResult,
  SessionEndResponse,
  SessionStartResponse,
  TrackerResponse,
  type JobOrder,
  type PostedWithin,
  type RunMode,
} from "../../../src/extension/contract";
import { allowed, isJobUrl, jobIdOf, TRACKER_URL } from "../shared/allowlist";
import { FLOORS, LIMITS } from "../shared/constants";
import type { Cmd, RunState, Todo } from "../shared/messages";
import { ApiError, call } from "./api";
import { log } from "./log";
import { session } from "./store";
import { navigateWorker, reloadWorker, workerTab } from "./tab";
import { broadcast, notify, refreshMe } from "./ui";

const TICK = "aupply-tick";
export const WATCHDOG = "aupply-watchdog";

// ---------------------------------------------------------------------------
// The lock and the pump
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
/** Run fn after every earlier state change has finished. */
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

export const getRun = () => session.get("run");
async function saveRun(run: RunState) {
  await session.set("run", run);
  void broadcast();
}

let pumping = false;
let again = false;
/** Advance the run as far as it can go without waiting. Safe to call at any time. */
export async function pump() {
  if (pumping) {
    again = true;
    return;
  }
  pumping = true;
  try {
    do {
      again = false;
      for (let i = 0; i < 40; i++) if (!(await locked(stepOnce))) break;
    } while (again);
  } catch (err) {
    log("runner", "pump error", String(err).slice(0, 200));
  } finally {
    pumping = false;
  }
}
export const kick = () => void setTimeout(() => void pump(), 0);

let timer: ReturnType<typeof setTimeout> | null = null;
/** Wake the pump at `at`: a timer for short waits, an alarm for long ones (and as a backstop). */
function wakeAt(at: number) {
  const ms = at - Date.now();
  if (timer) clearTimeout(timer);
  timer = null;
  if (ms <= LIMITS.timerWaitMs) timer = setTimeout(() => void pump(), Math.max(0, ms) + 50);
  void chrome.alarms.create(TICK, { when: Math.max(at, Date.now() + 30_000) + 100 });
}

// ---------------------------------------------------------------------------
// Words for the side panel
// ---------------------------------------------------------------------------

const clock = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const OUTCOME: Record<string, string> = {
  SENT: "Applied", UNCONFIRMED: "Submitted, not confirmed by LinkedIn yet", ALREADY_APPLIED: "Already applied", CLOSED: "No longer accepting applications",
  NO_EASY_APPLY: "Not Easy Apply", NOT_LOADED: "The job page did not load (will retry)", NO_MODAL: "The form did not open (will retry)",
  STALL: "The form would not move on (will retry)", NO_BUTTON: "No button to move on (will retry)", TITLE_MISMATCH: "A different page loaded (will retry)",
  DAILY_LIMIT: "LinkedIn's daily Easy Apply limit", RATE_LIMITED: "LinkedIn asked to slow down", ERR: "Something went wrong (will retry)",
  PROTECTED: "Asks for a fact Aupply never fills in", NEEDS_INPUT: "Needs your answer", NEEDS_CLICK: "Needed a click (will retry)",
  FOLLOW_STUCK: "The Follow box would not untick (will retry)", CHECKPOINT: "LinkedIn security check", LOGGED_OUT: "Signed out of LinkedIn",
  USER_NAVIGATED: "You used the Aupply tab",
};
const WAIT_TEXT: Record<string, string> = {
  rate_limited: "LinkedIn asked to slow down", lease_busy: "Another Aupply job is finishing", claude_active: "Claude is using LinkedIn",
  blocked: "LinkedIn pause", working: "Scoring jobs",
};

function waitFor(run: RunState, until: number, what: string) {
  run.pending = { kind: "time", until };
  const secs = Math.round((until - Date.now()) / 1000);
  run.status = secs <= 0 ? what : secs < 120 ? `Waiting ${secs}s (${what})` : `Waiting until ${clock(until)} (${what})`;
  wakeAt(until);
}

/** Wait until `at` before going on with the same todo; false when it is already time. */
function holdUntil(run: RunState, at: number, what: string): boolean {
  if (at - Date.now() <= 250) return false;
  waitFor(run, at, what);
  return true;
}

function pause(run: RunState, message: string) {
  run.phase = "paused";
  run.pending = { kind: "user", reason: message };
  run.message = message;
  run.status = `Paused: ${message}`;
  notify(message);
  log("runner", "paused", message.slice(0, 80));
}

// ---------------------------------------------------------------------------
// Commands in the worker tab
// ---------------------------------------------------------------------------

const newCmd = (name: Cmd["name"], args: unknown): Cmd => ({ cmd_id: crypto.randomUUID(), name, args });

/** Navigate the worker tab and send `cmd` once the page says it is ready. */
async function navigateThen(run: RunState, url: string, cmd: Cmd) {
  await navigateWorker(url);
  run.pending = { kind: "ready", cmd, deadline: Date.now() + LIMITS.readyTimeoutMs, url };
  wakeAt(run.pending.deadline);
}

/** A guest fetch runs from any LinkedIn page: use the worker tab as it is, else open the tracker. */
async function dispatchFetch(run: RunState, cmd: Cmd) {
  const tab = await workerTab();
  if (tab?.id != null && /^https:\/\/www\.linkedin\.com\//.test(tab.url ?? "") && tab.status === "complete") {
    try {
      const r = (await chrome.tabs.sendMessage(tab.id, { type: "cmd", ...cmd })) as { accepted?: boolean } | undefined;
      if (r?.accepted) {
        run.pending = { kind: "cmd", cmd, startedAt: Date.now() };
        run.lastProgressAt = Date.now();
        return;
      }
    } catch {
      /* no content script there yet */
    }
  }
  await navigateThen(run, TRACKER_URL, cmd);
}

/** Send a command to the worker tab now (it said ready). */
async function sendCmd(run: RunState, tabId: number, cmd: Cmd) {
  const r = (await chrome.tabs.sendMessage(tabId, { type: "cmd", ...cmd })) as { accepted?: boolean } | undefined;
  if (!r?.accepted) throw new Error("the page did not take the command");
  run.pending = { kind: "cmd", cmd, startedAt: Date.now() };
  run.lastProgressAt = Date.now();
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const STOP_POINTS = new Set<Todo["do"]>(["apply_next", "draft_start", "exec_job", "exec_draft", "exec_tracker"]);

async function stepOnce(): Promise<boolean> {
  const run = await getRun();
  if (!run || run.phase === "done") return false;
  const now = Date.now();
  if (run.pending) {
    if (run.pending.kind === "time") {
      if (now < run.pending.until) {
        wakeAt(run.pending.until);
        return false;
      }
      run.pending = undefined;
    } else if (run.pending.kind === "ready") {
      if (now <= run.pending.deadline) return false;
      await readyTimeout(run);
      await saveRun(run);
      return !run.pending;
    } else if (run.pending.kind === "cmd") {
      if (now - run.lastProgressAt <= LIMITS.stallMs) return false;
      await stalled(run);
      await saveRun(run);
      return !run.pending;
    } else return false;
  }
  if (run.stopRequested && (STOP_POINTS.has(run.todo.do) || (run.todo.do === "draft_next" && !run.todo.result))) {
    run.todo = { do: "end", reason: "user_stop" };
  }
  try {
    await perform(run);
    run.errors = 0;
  } catch (err) {
    onError(run, err);
  }
  await saveRun(run);
  // perform() may have ended the run (phase is widened again: it changed under TypeScript's narrowing).
  return !run.pending && (run.phase as RunState["phase"]) !== "done";
}

function onError(run: RunState, err: unknown) {
  const e = err instanceof ApiError ? err : null;
  log("runner", run.todo.do, "failed", e ? `${e.status} ${e.code}` : String(err).slice(0, 120));
  if (e && (e.status === 401 || e.status === 426)) {
    finishLocal(run, e.status === 426 ? "This version of the extension is out of date. Update it to go on." : "This browser was disconnected from Aupply.");
    return;
  }
  if (e?.status === 409 && /no longer live|not this browser/i.test(e.message)) {
    finishLocal(run, "This run ended elsewhere. Start a new one.");
    return;
  }
  // Aupply unreachable, a server error, or a race the next call settles: try again, slower each time.
  if (e && (e.status === 0 || e.status >= 500 || e.status === 409 || e.status === 429)) {
    run.errors = (run.errors ?? 0) + 1;
    if (run.errors <= 10) {
      waitFor(run, Date.now() + Math.min(5 * 60_000, 15_000 * run.errors), "Aupply did not answer, trying again");
      return;
    }
  }
  run.message = e ? e.message : "Something went wrong in the extension.";
  if (run.todo.do === "end" || (run.errors ?? 0) > 10) finishLocal(run, run.message);
  else run.todo = { do: "end", reason: "error" };
}

/** End the run here without asking the server (it is gone, or this device is). */
function finishLocal(run: RunState, message: string) {
  run.phase = "done";
  run.pending = undefined;
  run.message = message;
  run.status = message;
  void chrome.alarms.clear(TICK);
  void chrome.alarms.clear(WATCHDOG);
}

async function perform(run: RunState) {
  const t = run.todo;
  switch (t.do) {
    case "session_start":
      run.todo = { do: "end", reason: "error" };
      return;

    case "exec_tracker": {
      if (holdUntil(run, Date.parse(t.lease.not_before), "LinkedIn pacing")) return;
      run.phase = "tracker";
      run.status = "Reading your LinkedIn Applied count";
      await navigateThen(run, TRACKER_URL, newCmd("tracker", {}));
      return;
    }

    case "post_tracker": {
      await call("POST", "/linkedin/tracker", { lease_id: t.lease.lease_id, count: t.count }, TrackerResponse);
      log("tracker", t.count);
      run.todo = run.plan.draft && !run.draftId ? { do: "draft_start" } : run.plan.apply ? { do: "apply_next" } : { do: "end", reason: "done" };
      return;
    }

    case "draft_start": {
      run.phase = "drafting";
      run.status = "Starting the search";
      const r = await call("POST", "/linkedin/draft/start", { run_id: run.runId }, DraftStartResponse);
      if (r.type === "started") {
        run.draftId = r.draft_id;
        log("draft", "started", r.searching.roles.length, "roles", r.searching.posted_within);
        onDraftOrder(run, r.order);
        return;
      }
      run.draftDone = true;
      if (r.type === "no_roles") run.message = r.message;
      else if (r.type === "blocked") run.message = `LinkedIn search is paused until ${r.until ? clock(r.until) : "later"}.`;
      else if (r.type === "cap_reached") run.message = "Today's LinkedIn Easy Apply limit is used.";
      else run.message = r.message;
      run.todo = run.plan.apply && r.type !== "cap_reached" && r.type !== "disabled" ? { do: "apply_next" } : { do: "end", reason: r.type === "cap_reached" ? "cap" : r.type === "blocked" ? "blocked" : "error" };
      return;
    }

    case "draft_next": {
      const order = await call("POST", "/linkedin/draft/next", { draft_id: run.draftId, ...(t.leaseId ? { lease_id: t.leaseId } : {}), ...(t.result ? { result: t.result } : {}) }, DraftOrder);
      onDraftOrder(run, order);
      return;
    }

    case "exec_draft": {
      const o = t.order;
      const urls = o.type === "search" ? o.pages.map((p) => p.url) : o.jobs.map((j) => j.url);
      if (!urls.every(allowed)) {
        log("draft", "refused an order with a URL outside the allowlist");
        run.message = "Aupply sent an address the extension does not allow. The run stopped.";
        run.todo = { do: "end", reason: "error" };
        return;
      }
      if (holdUntil(run, Date.parse(o.not_before), "LinkedIn pacing")) return;
      run.status = o.type === "search" ? `Searching LinkedIn (${o.pages.length} page${o.pages.length > 1 ? "s" : ""})` : `Reading ${o.jobs.length} job description${o.jobs.length > 1 ? "s" : ""}`;
      const args = o.type === "search" ? { pages: o.pages, gap_ms: Math.max(o.gap_ms, FLOORS.searchGapMs) } : { jobs: o.jobs, gap_ms: Math.max(o.gap_ms, FLOORS.jdGapMs) };
      await dispatchFetch(run, newCmd(o.type, args));
      return;
    }

    case "apply_next": {
      run.phase = "applying";
      const r = await call("POST", "/linkedin/apply/next", { run_id: run.runId }, ApplyNextResponse);
      if (r.type === "job") run.todo = { do: "exec_job", lease: r };
      else if (r.type === "tracker") run.todo = { do: "exec_tracker", lease: r };
      else if (r.type === "wait") waitFor(run, Date.parse(r.until), WAIT_TEXT[r.reason] ?? "waiting");
      else if (r.type === "done") {
        run.message =
          r.reason === "cap" ? "Today's LinkedIn Easy Apply limit is reached."
          : r.reason === "blocked" ? `LinkedIn is paused until ${r.until ? clock(r.until) : "later"}.`
          : r.waiting_on_you ? `Nothing left to apply to. ${r.waiting_on_you} job${r.waiting_on_you > 1 ? "s wait" : " waits"} for your answers.`
          : "Nothing left to apply to.";
        run.todo = { do: "end", reason: r.reason === "cap" ? "cap" : r.reason === "blocked" ? "blocked" : "done" };
      } else {
        run.message = r.message;
        run.todo = { do: "end", reason: "error" };
      }
      return;
    }

    case "exec_job": {
      const l = t.lease;
      if (!isJobUrl(l.job.url)) {
        log("job", "refused a job URL outside the allowlist");
        run.message = "Aupply sent an address the extension does not allow. The run stopped.";
        run.todo = { do: "end", reason: "error" };
        return;
      }
      const at = Math.max(Date.parse(l.not_before), (run.lastJobEndAt ?? 0) + FLOORS.betweenJobsMs);
      if (holdUntil(run, at, "LinkedIn pacing")) return;
      run.phase = "applying";
      run.status = `Applying to ${l.job.title || "a job"}${l.job.company ? ` at ${l.job.company}` : ""}`;
      const pageWait = Math.max(l.page_wait_ms, run.slow ? FLOORS.pageWaitSlowMs : FLOORS.pageWaitMs);
      await navigateThen(run, l.job.url, newCmd("apply", { job: l.job, page_wait_ms: pageWait, country: l.country, lease_id: l.lease_id }));
      return;
    }

    case "post_result": {
      const res = await call("POST", "/linkedin/apply/result", { lease_id: t.lease.lease_id, result: t.result }, ApplyResultResponse);
      recordResult(run, t.lease, t.result, res);
      run.lastJobEndAt = Date.now();
      const after = run.after;
      run.after = undefined;
      if (after?.end) run.todo = { do: "end", reason: after.end };
      else if (after?.pause) {
        run.todo = { do: "apply_next" };
        pause(run, after.pause);
      } else if (res.next.type === "pause") {
        run.todo = { do: "apply_next" };
        pause(run, "You used the Aupply tab, so the run paused. Press Resume when you are done.");
      } else if (res.next.type === "stop") {
        if (res.next.reason === "checkpoint" || res.next.reason === "logged_out") {
          run.todo = { do: "apply_next" };
          pause(run, res.next.reason === "checkpoint" ? "LinkedIn is showing a security check. Complete it yourself in the Aupply tab, then press Resume." : "Sign in to LinkedIn in the Aupply tab, then press Resume.");
        } else {
          run.message = res.next.reason === "cap" ? "LinkedIn's daily Easy Apply limit is reached." : res.next.reason === "rate_limited" ? "LinkedIn asked to slow down twice, so LinkedIn rests for a few hours." : "Stopped.";
          run.todo = { do: "end", reason: res.next.reason === "cap" ? "cap" : "blocked" };
        }
      } else run.todo = run.stopRequested ? { do: "end", reason: "user_stop" } : { do: "apply_next" };
      return;
    }

    case "end": {
      run.phase = "ending";
      run.status = "Finishing";
      try {
        const r = await call("POST", "/session/end", { run_id: run.runId, reason: t.reason }, SessionEndResponse);
        run.endSummary = { counts: r.counts, saved: r.saved_for_you.length, provisional: r.provisional_used.length, trackerMismatch: Boolean(r.tracker_mismatch) };
      } catch (err) {
        log("runner", "session/end failed", String(err).slice(0, 80));
      }
      const sent = run.counters.sent + run.counters.unconfirmed;
      finishLocal(run, run.message ?? (t.reason === "user_stop" ? "Stopped." : "Done."));
      notify(`Run finished: ${sent} application${sent === 1 ? "" : "s"} sent.${run.message ? ` ${run.message}` : ""}`);
      log("runner", "ended", t.reason, run.counters);
      void refreshMe().then(broadcast).catch(() => undefined);
      return;
    }
  }
}

function onDraftOrder(run: RunState, order: DraftOrder) {
  if (order.type === "search" || order.type === "jd") run.todo = { do: "exec_draft", order };
  else if (order.type === "wait") {
    run.todo = { do: "draft_next" };
    waitFor(run, Date.parse(order.until), WAIT_TEXT[order.reason] ?? "waiting");
  } else if (order.type === "done") {
    run.draftSummary = order.summary;
    run.draftDone = true;
    log("draft", "done", order.summary.kept, "kept", order.summary.stop ?? "");
    run.todo = run.plan.apply ? { do: "apply_next" } : { do: "end", reason: "done" };
    if (!run.plan.apply) run.message = `Found ${order.summary.kept} job${order.summary.kept === 1 ? "" : "s"} for your queue.`;
  } else {
    run.message = order.message;
    run.todo = { do: "end", reason: "error" };
  }
}

function recordResult(run: RunState, lease: JobOrder, sent: ApplyResult, res: ApplyResultResponse) {
  const r = sent.r;
  const c = run.counters;
  if (r === "SENT") c.sent++;
  else if (r === "UNCONFIRMED") c.unconfirmed++;
  else if (r === "NEEDS_INPUT") {
    c.waiting++;
    notify("Aupply needs an answer from you. Open the side panel.");
  } else if (res.status === "failed") c.failed++;
  else if (res.status && ["skipped", "saved", "closed"].includes(res.status)) c.skipped++;
  if (r === "RATE_LIMITED") run.slow = true;
  run.notLoadedStreak = r === "NOT_LOADED" ? run.notLoadedStreak + 1 : 0;
  const words = res.status === "saved" ? "Saved for you to apply on the company site" : OUTCOME[r] ?? r;
  run.recent.unshift({ id: lease.job.id, title: lease.job.title, company: lease.job.company, result: words, at: new Date().toISOString() });
  run.recent = run.recent.slice(0, LIMITS.recentResults);
  log("job", lease.lease_id.slice(0, 8), r, res.status ?? "-", res.next.type);
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

async function readyTimeout(run: RunState) {
  const p = run.pending;
  if (p?.kind !== "ready") return;
  run.pending = undefined;
  run.notLoadedStreak++;
  log("runner", "page did not load", p.cmd.name);
  if (p.cmd.name === "apply" && run.todo.do === "exec_job") {
    if (run.notLoadedStreak >= 2) run.after = { pause: "LinkedIn pages are not loading in the Aupply tab. Check the tab, then press Resume." };
    run.todo = { do: "post_result", lease: run.todo.lease, result: { r: "NOT_LOADED" } };
  } else if (p.cmd.name === "tracker" && run.todo.do === "exec_tracker") {
    run.todo = { do: "post_tracker", lease: run.todo.lease, count: null };
  } else if (run.notLoadedStreak >= 2) {
    run.todo = run.draftId ? { do: "draft_next" } : { do: "apply_next" };
    pause(run, "LinkedIn pages are not loading in the Aupply tab. Check the tab, then press Resume.");
  } else run.todo = { do: "draft_next", leaseId: run.todo.do === "exec_draft" ? run.todo.order.lease_id : undefined };
}

/** The watchdog's rule: a command with no progress for 5 minutes is stuck. The tab is reloaded
    (which ends whatever the page was doing); twice in a run ends it as stalled (li_main). */
async function stalled(run: RunState) {
  const p = run.pending;
  if (p?.kind !== "cmd") return;
  run.pending = undefined;
  run.stalls++;
  log("runner", "stalled", p.cmd.name, run.stalls);
  await reloadWorker();
  if (p.cmd.name === "apply" && run.todo.do === "exec_job") {
    if (run.stalls >= 2) run.after = { end: "stalled" };
    run.todo = { do: "post_result", lease: run.todo.lease, result: { r: "ERR", e: "job_timeout" } };
  } else {
    run.message = "The LinkedIn tab stopped responding.";
    run.todo = { do: "end", reason: "stalled" };
  }
}

// ---------------------------------------------------------------------------
// Events from the worker tab
// ---------------------------------------------------------------------------

/** cs/ready from the worker tab. Answers whether the page is the worker. */
export async function onReady(tabId: number, m: { url: string; loggedIn: boolean; checkpoint: boolean; hidden: boolean }): Promise<"worker" | "idle"> {
  const worker = await session.get("workerTabId");
  if (worker !== tabId) return "idle";
  await session.set("lastHidden", m.hidden);
  const role = await locked(async () => {
    const run = await getRun();
    if (!run || run.phase === "done") return "idle" as const;
    const p = run.pending;
    if (p?.kind === "ready") {
      const job = p.cmd.name === "apply" ? jobIdOf(p.url) : null;
      if (job && jobIdOf(m.url) !== job && m.loggedIn && !m.checkpoint) return "worker" as const; // not the page we asked for (yet)
      if (!job && !/^https:\/\/www\.linkedin\.com\//.test(m.url)) return "worker" as const;
      if (m.checkpoint || !m.loggedIn) {
        run.pending = undefined;
        const r = m.checkpoint ? "CHECKPOINT" : "LOGGED_OUT";
        if (run.todo.do === "exec_job") run.todo = { do: "post_result", lease: run.todo.lease, result: { r } };
        else {
          run.todo = run.todo.do === "exec_tracker" ? run.todo : run.draftId && !run.draftDone ? { do: "draft_next" } : { do: "apply_next" };
          pause(run, m.checkpoint ? "LinkedIn is showing a security check. Complete it yourself in the Aupply tab, then press Resume." : "Sign in to LinkedIn in the Aupply tab, then press Resume.");
        }
        await saveRun(run);
        return "worker" as const;
      }
      try {
        await sendCmd(run, tabId, p.cmd);
        run.notLoadedStreak = 0;
      } catch (err) {
        log("runner", "send failed", String(err).slice(0, 80));
      }
      await saveRun(run);
      return "worker" as const;
    }
    if (p?.kind === "cmd") {
      // The worker page loaded again in the middle of a command.
      if (p.cmd.name === "apply" && run.todo.do === "exec_job") {
        const same = jobIdOf(m.url) === run.todo.lease.job.id;
        run.pending = undefined;
        run.todo = { do: "post_result", lease: run.todo.lease, result: same ? { r: "ERR", e: "page_reloaded" } : { r: "USER_NAVIGATED" } };
      } else if (/^https:\/\/www\.linkedin\.com\//.test(m.url) && m.loggedIn) {
        // A guest fetch or a tracker read: run it again on this page.
        const cmd = newCmd(p.cmd.name, p.cmd.args);
        try {
          await sendCmd(run, tabId, cmd);
        } catch {
          run.pending = undefined;
        }
      }
      await saveRun(run);
      return "worker" as const;
    }
    return "worker" as const;
  });
  kick();
  return role;
}

export async function onProgress(cmdId: string) {
  await locked(async () => {
    const run = await getRun();
    if (run?.pending?.kind === "cmd" && run.pending.cmd.cmd_id === cmdId) {
      run.lastProgressAt = Date.now();
      await session.set("run", run);
    }
  });
}

/** cs/done: a command finished in the worker tab. */
export async function onDone(cmdId: string, result: unknown) {
  await locked(async () => {
    const run = await getRun();
    if (!run || run.pending?.kind !== "cmd" || run.pending.cmd.cmd_id !== cmdId) return; // stale or repeated
    const cmd = run.pending.cmd;
    run.pending = undefined;
    run.lastProgressAt = Date.now();
    const failed = result && typeof result === "object" && "error" in result ? String((result as { error: unknown }).error) : null;
    const t = run.todo;
    if (cmd.name === "tracker" && t.do === "exec_tracker") {
      const count = (result as { count?: unknown } | null)?.count;
      run.todo = { do: "post_tracker", lease: t.lease, count: typeof count === "number" ? count : null };
    } else if ((cmd.name === "search" || cmd.name === "jd") && t.do === "exec_draft") {
      const parsed = (cmd.name === "search" ? SearchResult : JdResult).safeParse(result);
      if (failed || !parsed.success) {
        log("draft", "fetch failed", failed?.slice(0, 80) ?? "bad result");
        run.message = "Reading LinkedIn's job search failed in the extension.";
        run.todo = { do: "end", reason: "error" };
      } else run.todo = { do: "draft_next", leaseId: t.order.lease_id, result: parsed.data };
    } else if (cmd.name === "apply" && t.do === "exec_job") {
      const parsed = ApplyResult.safeParse(result);
      run.todo = { do: "post_result", lease: t.lease, result: parsed.success ? parsed.data : { r: "ERR", e: (failed ?? "bad result").slice(0, 300) } };
    }
    await saveRun(run);
  });
  kick();
}

export async function onHandoff(m: { what: "typeahead" | "follow"; label: string; value?: string; done?: boolean }) {
  await locked(async () => {
    const run = await getRun();
    if (!run) return;
    if (m.done) run.handoff = undefined;
    else {
      run.handoff = { what: m.what, label: m.label, value: m.value, until: Date.now() + LIMITS.handoffMs };
      notify(m.what === "follow" ? "Aupply needs one click: untick Follow in the Aupply tab." : `Aupply needs one click: choose ${m.value ?? "the suggestion"} in the Aupply tab.`);
    }
    await saveRun(run);
  });
}

export async function onTabClosed(tabId: number) {
  const worker = await session.get("workerTabId");
  if (worker !== tabId) return;
  await session.remove("workerTabId");
  await locked(async () => {
    const run = await getRun();
    if (!run || run.phase === "done" || run.phase === "paused") return;
    run.pending = undefined;
    if (run.todo.do === "exec_job" || run.todo.do === "post_result") run.todo = { do: "apply_next" };
    else if (run.todo.do === "exec_draft") run.todo = { do: "draft_next" };
    pause(run, "The LinkedIn tab Aupply was using was closed. Press Resume to open a new one.");
    await saveRun(run);
  });
}

// ---------------------------------------------------------------------------
// From the side panel
// ---------------------------------------------------------------------------

export async function startRun(mode: RunMode, postedWithin: PostedWithin) {
  const current = await getRun();
  if (current && current.phase !== "done") throw new Error("A run is already going.");
  const r = await call("POST", "/session/start", { mode, posted_within: postedWithin }, SessionStartResponse);
  if (r.type !== "started") return r;
  const run: RunState = {
    runId: r.run_id, mode, postedWithin: r.posted_within, plan: r.plan, phase: "starting", status: "Starting",
    todo: r.first.type === "tracker" ? { do: "exec_tracker", lease: r.first } : r.plan.draft ? { do: "draft_start" } : { do: "apply_next" },
    stopRequested: false, counters: { sent: 0, unconfirmed: 0, skipped: 0, failed: 0, waiting: 0 }, recent: [], lastProgressAt: Date.now(),
    stalls: 0, notLoadedStreak: 0, slow: false,
  };
  if (r.first.type === "wait") waitFor(run, Date.parse(r.first.until), WAIT_TEXT[r.first.reason] ?? "waiting");
  await locked(() => saveRun(run));
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  log("runner", "started", mode, r.posted_within, r.plan);
  kick();
  return r;
}

export async function requestStop() {
  await locked(async () => {
    const run = await getRun();
    if (!run || run.phase === "done") return;
    run.stopRequested = true;
    run.status = "Stopping after the current step";
    if (run.pending?.kind === "time" || run.pending?.kind === "user") {
      run.pending = undefined;
      if (STOP_POINTS.has(run.todo.do) || run.todo.do === "draft_next") run.todo = { do: "end", reason: "user_stop" };
    }
    await saveRun(run);
  });
  kick();
}

export async function resume() {
  await locked(async () => {
    const run = await getRun();
    if (!run || run.phase !== "paused") return;
    run.pending = undefined;
    run.message = undefined;
    run.phase = run.draftId && !run.draftDone ? "drafting" : "applying";
    run.notLoadedStreak = 0;
    await saveRun(run);
  });
  kick();
}

/** Every minute while a run is going: the heartbeat (obey stop), then the pump. */
export async function watchdog() {
  const run = await getRun();
  if (!run || run.phase === "done") {
    await chrome.alarms.clear(WATCHDOG);
    return;
  }
  try {
    const hb = await call("POST", "/session/heartbeat", { run_id: run.runId, phase: run.phase, hidden: Boolean(await session.get("lastHidden")) }, HeartbeatResponse);
    if (hb.stop) {
      await locked(async () => {
        const cur = await getRun();
        if (!cur || cur.phase === "done") return;
        const why = hb.stop!.reason;
        finishLocal(cur, why === "disabled" ? "Aupply paused LinkedIn in the extension for now." : "This run was ended from somewhere else.");
        await saveRun(cur);
      });
    }
  } catch (err) {
    log("runner", "heartbeat failed", err instanceof ApiError ? `${err.status} ${err.code}` : String(err).slice(0, 80));
  }
  await locked(async () => {
    const cur = await getRun();
    if (cur?.handoff && Date.now() > cur.handoff.until) {
      cur.handoff = undefined;
      await saveRun(cur);
    }
  });
  kick();
}

/** The signed-out handler: the run cannot go on without a device. */
export async function stopForSignOut(message: string) {
  await locked(async () => {
    const run = await getRun();
    if (!run || run.phase === "done") return;
    finishLocal(run, message);
    await saveRun(run);
  });
}

export { TICK };
