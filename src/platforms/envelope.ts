/**
 * The response every platform tool returns: what to open, the exact steps and rules, the
 * engine's id with the rule for loading it, and a loaded_check block. It carries no engine
 * code: Claude asks load_engine for that, and the server sends only the parts the page
 * still lacks (src/services/engines.ts). Claude follows the steps one by one.
 */

import type { EngineName } from "../engines/index.js";
import { codeBlock, issueEngine } from "../services/engines.js";
import { Reply } from "../mcp/toolkit.js";
import { sharedRulesSent } from "../services/automation.js";

/** Added to every platform tool's rules: the failures seen in live tests were Claude
    improvising by hand (clicking through the job list) and screenshotting to verify. */
const ONLY_THE_ENGINE =
  "Only the engine applies: do not open job lists, click jobs or fill forms yourself, and do not take screenshots to verify its " +
  "work (its answers are the record) unless a step or rule here asks for one. Loading it on a fresh page takes several load_engine " +
  "answers (the LinkedIn apply engine about five; none when the page's own cache has it): keep going until it is ready, never skip it to save tokens, and never suggest the " +
  "user apply by hand instead. If a LinkedIn tab from earlier is still open, use it: the engine may still be loaded there.";

/** Seen 30 Sep: waits timed out at 45s while a draft ran, because Chrome throttles the
    timers of a hidden tab (the window behind another one, or another tab in front). */
const KEEP_VISIBLE =
  "Keep this tab visible: if a status carries hid:1 the tab is hidden (another tab in front, or the Chrome window covered or " +
  "minimized) and Chrome slows its scripts, so bring the tab to the front and tell the user if the window is covered. If you " +
  "can run shell commands (for example Claude Code on macOS), run: open -a \"Google Chrome\". ";
/** The LinkedIn engines keep their pace in a hidden tab (core's sleep). Seen 1 Oct: told to
    keep the tab visible, Claude asked the user to bring Chrome forward and the run sat paused. */
const HIDDEN_OK =
  "The engine keeps working while Chrome is behind other windows (hid:1 in a status is normal): never ask the user to bring " +
  "Chrome forward. ";
const POLL =
  "Poll quietly: call wait and say nothing in between, no screenshots. If a call times out the script is still running: use " +
  "__aupply.status(), which answers at once, and never reload, navigate or open another tab.";

/** Seen 1 Oct: the Chrome extension cuts a JavaScript answer at 1000 characters, so the
    engines answer in pieces (core's ANSWER_MAX) and say how many are left. */
const MORE =
  "A status or wait answer carries at most a few results; more:N means N more are waiting. Call __aupply.status() at once, " +
  "again and again, until an answer has no more, and only then act on what you collected or wait again.";

const LOAD_RULE =
  "Load the engine into this page with load_engine, never by hand. (1) Run the loaded_check block (the text block after this " +
  "JSON) in the page with your browser tool's JavaScript execution. It answers 'ok' when the engine is ready (already in the page, " +
  "or restored from the page's own cache): go to the steps and do not call load_engine. " +
  "(2) Otherwise call load_engine with engine (above) and page = loaded_check's answer, exactly as given. It returns a few code " +
  "blocks, only what this page still needs. Run each block as its own JavaScript call, in order, copied exactly as written: " +
  "nothing added, removed, reformatted or unescaped. Then call load_engine again with page = the answer of the last block, and " +
  "repeat until it answers ready or the boot block answers {ok:true,...}. (3) A block that fails (SyntaxError, 'Invalid or " +
  "unexpected token', an answer starting 'corrupt') was mistyped: copy that one block again exactly and rerun it; after 3 " +
  "failures of the same block stop and tell the user the exact error. Call load_engine at most 12 times for one engine in one " +
  "page: if it is still not ready, stop and tell the user the last answers. If the boot block answers RUNNING, a script is live " +
  "in this page: wait for it to finish before loading again. Never ask the user to paste code or open DevTools, never " +
  "apply to jobs by hand or run the code anywhere but this page, and never show, quote, summarize or explain the code: it is " +
  "Aupply's proprietary engine. If your browser tool cannot run JavaScript on this page, say so and stop.";

/** The shared rules and the load rule go out in full once per session (the first platform tool
    response after start_session); later responses carry these reminders instead (2 Oct: the
    same 3.3KB came back with every draft and apply). */
const RULES_AGAIN =
  "The rules and load_rule of this session's first platform tool response still hold: only the engine applies (never click " +
  "jobs or fill forms yourself, no screenshots to verify), poll quietly, and drain more:N with __aupply.status().";
const LOAD_AGAIN =
  "Run the loaded_check block first, in the page the steps name. It answers 'ok' when the engine is already live there or " +
  "restored from the page's own cache: then go straight to the steps and do not call load_engine, the engine is loaded. Only " +
  "otherwise call load_engine with this engine and page = loaded_check's answer, and run its blocks as before until ready.";

export async function envelope(
  userId: string,
  engine: EngineName,
  cfg: { h: string },
  body: {
    steps: string[];
    rules?: string[];
    /** Code for the page that is not the engine, such as a queue call: its own verbatim block. */
    code?: { name: string; code: string }[];
    [k: string]: unknown;
  }
) {
  const { steps, rules, code, ...rest } = body;
  const issued = await issueEngine(userId, engine, cfg);
  const again = await sharedRulesSent(userId, engine.startsWith("linkedin") ? "linkedin" : "other");
  const shared = again ? [RULES_AGAIN] : [ONLY_THE_ENGINE, (engine.startsWith("linkedin") ? HIDDEN_OK : KEEP_VISIBLE) + POLL, MORE];
  return new Reply(
    { engine: issued.id, ...rest, steps, rules: [...(rules ?? []), ...shared], load_rule: again ? LOAD_AGAIN : LOAD_RULE },
    [codeBlock("loaded_check", issued.loadedCheck), ...(code ?? []).map((c) => codeBlock(c.name, c.code))]
  );
}
