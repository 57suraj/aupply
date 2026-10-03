/**
 * Content script, injected into every LinkedIn page. It does nothing at all unless the service
 * worker says this tab is the run's worker tab. It never reads extension storage, never sees a
 * token and never contacts Aupply: commands come from the service worker, results go back to it
 * as messages (cs/done), progress every 15 seconds so the service worker knows it is alive.
 */

import type { AnswersReply, ClickReply, ContentToSw, ReadyAnswer, SwToContent } from "../shared/messages";
import { LIMITS } from "../shared/constants";
import { checkpoint, loggedOut } from "./linkedin/dom";
import { jdPages, searchPages } from "./linkedin/guestFetch";
import { applyJob, type Bridge, type JobArgs } from "./linkedin/job";
import { readTracker } from "./linkedin/tracker";

const send = <T = unknown>(m: ContentToSw) => chrome.runtime.sendMessage(m) as Promise<T>;

let busy: string | null = null;

function bridgeFor(cmdId: string, leaseId: string): Bridge {
  return {
    async answers(page, company, fields) {
      const reply = await Promise.race([
        send<AnswersReply>({ type: "cs/answers", cmd_id: cmdId, lease_id: leaseId, page, company, fields }),
        new Promise<AnswersReply>((r) => setTimeout(() => r({ ok: false, error: "answers_timeout" }), LIMITS.answersTimeoutMs)),
      ]);
      if (!reply?.ok) throw new Error(reply?.error || "answers_failed");
      return reply.answers;
    },
    async trustedClick(x, y) {
      const r = await send<ClickReply>({ type: "cs/clickRequest", cmd_id: cmdId, x, y, dpr: window.devicePixelRatio || 1 }).catch(() => null);
      return Boolean(r?.ok);
    },
    async handoff(what, label, value, done) {
      await send({ type: "cs/handoff", cmd_id: cmdId, what, label, value, done }).catch(() => undefined);
    },
    progress(note) {
      send({ type: "cs/progress", cmd_id: cmdId, note }).catch(() => undefined);
    },
  };
}

async function run(cmd: SwToContent) {
  busy = cmd.cmd_id;
  const beat = setInterval(() => send({ type: "cs/progress", cmd_id: cmd.cmd_id }).catch(() => undefined), LIMITS.progressEveryMs);
  const progress = (note: string) => send({ type: "cs/progress", cmd_id: cmd.cmd_id, note }).catch(() => undefined);
  let result: unknown;
  try {
    if (cmd.name === "tracker") result = await readTracker();
    else if (cmd.name === "search") result = await searchPages(cmd.args as Parameters<typeof searchPages>[0], progress);
    else if (cmd.name === "jd") result = await jdPages(cmd.args as Parameters<typeof jdPages>[0], progress);
    else if (cmd.name === "apply") {
      const a = cmd.args as JobArgs & { lease_id: string };
      result = await applyJob(a, bridgeFor(cmd.cmd_id, a.lease_id));
    }
  } catch (err) {
    result = { error: String((err as Error)?.message ?? err).slice(0, 300) };
  } finally {
    clearInterval(beat);
    busy = null;
  }
  await send({ type: "cs/done", cmd_id: cmd.cmd_id, result }).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((msg: SwToContent, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== "cmd") return;
  if (busy) {
    reply({ accepted: false, busy });
    return;
  }
  reply({ accepted: true });
  void run(msg);
});

// Say hello; the service worker answers whether this tab is the worker.
void send<ReadyAnswer>({ type: "cs/ready", url: location.href, loggedIn: !loggedOut(), checkpoint: checkpoint(), hidden: document.hidden }).catch(() => undefined);
