/**
 * Service worker entry: every listener registered at the top level (Manifest V3), a router for
 * the side panel's requests and the content script's messages, alarms and tab events. Messages
 * are accepted only from this extension; content messages only from the worker tab (any LinkedIn
 * tab may say cs/ready, and is told it is idle).
 */

import {
  AnswersResponse,
  DecisionsResponse,
  DecisionsResult,
  OkResponse,
  OnboardingProposeResponse,
  OnboardingSaveResponse,
  QueueResponse,
  QuestionAnswerResponse,
  QuestionDismissResponse,
  QuestionsResponse,
  ReviewItem,
  ReviewResponse,
} from "../../../src/extension/contract";
import { z } from "zod";
import type { ContentToSw, PanelRequest, PanelResponse } from "../shared/messages";
import { ApiError, call, setSignedOutHandler, setUpdateRequiredHandler } from "./api";
import { cancelPairing, forget, pollPairing, signOut, startPairing } from "./auth";
import { log, logText } from "./log";
import {
  getRun, kick, onDone, onHandoff, onProgress, onReady, onTabClosed, pump, requestStop, resume, startRun, stopForSignOut, TICK, WATCHDOG, watchdog,
} from "./runner";
import { local, session } from "./store";
import { trustedClick } from "./tab";
import { broadcast, buildState, refreshMe } from "./ui";

// Credentials gone (revoked on the website, or replayed): forget them; the run's next call fails and ends it.
setSignedOutHandler(async (why) => {
  log("auth", "signed out by the server", why);
  await forget();
  void broadcast();
});
setUpdateRequiredHandler(async () => {
  log("auth", "update required");
  void broadcast();
});

const openOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
// Installed or updated (a new zip loaded): an "update required" from the old version no longer holds.
chrome.runtime.onInstalled.addListener(() => {
  void openOnClick();
  void local.remove("updateRequired");
});
chrome.runtime.onStartup.addListener(() => void openOnClick());

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === WATCHDOG) void watchdog();
  else if (a.name === TICK) void pump();
});
chrome.tabs.onRemoved.addListener((tabId) => void onTabClosed(tabId));

// ---------------------------------------------------------------------------
// The side panel
// ---------------------------------------------------------------------------

const ok = <T>(data: T): PanelResponse<T> => ({ ok: true, data });
const fail = (err: unknown): PanelResponse => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
  ...(err instanceof ApiError ? { code: err.code } : {}),
});

async function withMe<T>(p: Promise<T>) {
  const r = await p;
  await refreshMe().catch(() => undefined);
  void broadcast();
  return r;
}

async function onPanel(m: PanelRequest): Promise<PanelResponse> {
  switch (m.type) {
    case "state/get": {
      if (await local.get("auth")) {
        const me = await session.get("me");
        if (!me || Date.now() - me.at > 30_000) await refreshMe().catch(() => undefined);
      }
      return ok(await buildState());
    }
    case "auth/start":
      return ok(await startPairing(m.deviceName).then(async (p) => (void broadcast(), p)));
    case "auth/poll": {
      const status = await pollPairing();
      if (status === "approved") await refreshMe().catch(() => undefined);
      void broadcast();
      return ok(status);
    }
    case "auth/cancel":
      await cancelPairing();
      void broadcast();
      return ok(true);
    case "auth/signout": {
      const run = await getRun();
      if (run && run.phase !== "done") await stopForSignOut("You signed out of Aupply in this browser.");
      await signOut();
      void broadcast();
      return ok(true);
    }
    case "me/refresh":
      await refreshMe();
      void broadcast();
      return ok(true);
    case "run/start": {
      const settings = (await local.get("settings")) ?? {};
      await local.set("settings", { ...settings, postedWithin: m.postedWithin });
      return ok(await startRun(m.mode, m.postedWithin));
    }
    case "run/stop":
      await requestStop();
      return ok(true);
    case "run/resume":
      await resume();
      return ok(true);
    case "questions/list":
      return ok(await call("GET", "/questions", undefined, QuestionsResponse));
    case "questions/answer":
      return ok(await withMe(call("POST", `/questions/${m.id}/answer`, { answer: m.answer }, QuestionAnswerResponse)));
    case "questions/dismiss":
      return ok(await withMe(call("POST", `/questions/${m.id}/dismiss`, {}, QuestionDismissResponse)));
    case "decisions/list":
      return ok(await call("GET", "/linkedin/decisions", undefined, DecisionsResponse));
    case "decisions/submit":
      return ok(await withMe(call("POST", "/linkedin/decisions", { items: m.items }, DecisionsResult)));
    case "review/list":
      return ok(await call("GET", "/answers/review", undefined, ReviewResponse));
    case "review/confirm":
      return ok(await withMe(call("POST", `/answers/${m.id}/confirm`, m.answer ? { answer: m.answer } : {}, ReviewItem)));
    case "queue/list": {
      const run = await getRun();
      const within = run && run.phase !== "done" ? run.postedWithin : (await local.get("settings"))?.postedWithin;
      return ok(await call("GET", `/linkedin/queue${within ? `?posted_within=${within}` : ""}`, undefined, QueueResponse));
    }
    case "queue/remove":
      return ok(await withMe(call("POST", `/linkedin/queue/${m.id}/skip`, {}, OkResponse)));
    case "setup/propose":
      return ok(await call("POST", "/onboarding/propose", {}, OnboardingProposeResponse));
    case "setup/save":
      return ok(await withMe(call("POST", "/onboarding/save", m.body, OnboardingSaveResponse)));
    case "settings/rename": {
      const r = await call("PATCH", "/device", { name: m.name }, z.object({ id: z.string(), name: z.string() }));
      const auth = await local.get("auth");
      if (auth) await local.set("auth", { ...auth, deviceName: r.name });
      void broadcast();
      return ok(r);
    }
    case "perm/debugger":
      void broadcast();
      return ok(true);
    case "log/copy":
      return ok(await logText());
  }
}

// ---------------------------------------------------------------------------
// The content script
// ---------------------------------------------------------------------------

async function onContent(m: ContentToSw, tabId: number): Promise<unknown> {
  if (m.type === "cs/ready") return { role: await onReady(tabId, m) };
  // Anything else only from the worker tab.
  if ((await session.get("workerTabId")) !== tabId) return { ok: false, error: "not the worker tab" };
  switch (m.type) {
    case "cs/progress":
      await onProgress(m.cmd_id);
      return { ok: true };
    case "cs/answers": {
      void onProgress(m.cmd_id);
      try {
        const answers = await call("POST", "/linkedin/apply/answers", { lease_id: m.lease_id, page: m.page, company: m.company, fields: m.fields }, AnswersResponse);
        log("answers", m.lease_id.slice(0, 8), `page ${m.page.index}`, answers.verdict, `${m.fields.length} fields`, answers.ai_used ? "ai" : "");
        return { ok: true, answers };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case "cs/clickRequest":
      void onProgress(m.cmd_id);
      return trustedClick(tabId, m.x, m.y);
    case "cs/handoff":
      await onHandoff(m);
      return { ok: true };
    case "cs/done":
      await onDone(m.cmd_id, m.result);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return;
  if (msg.type === "state/changed") return; // our own broadcast
  if (sender.tab?.id != null) {
    if (!msg.type.startsWith("cs/")) return;
    onContent(msg as ContentToSw, sender.tab.id).then(reply, (err) => reply({ ok: false, error: String(err) }));
    return true;
  }
  onPanel(msg as PanelRequest).then(reply, (err) => reply(fail(err)));
  return true;
});

// Every time the service worker starts: carry on with a run that was going.
void openOnClick();
kick();
