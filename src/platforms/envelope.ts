/**
 * The response every platform tool returns: what to open, the engine as small numbered
 * parts with the check that says which ones the page needs, the exact expressions to
 * run, and what to report. Claude follows it step by step.
 */

import { engineParts, type EnginePlatform } from "../engines/index.js";

const PASTE_RULE =
  "Load the engine first, with your browser tool's JavaScript execution on this page: run loaded_check exactly as " +
  "given. 'ok' means it is ready: go to the steps. Otherwise it answers 'paste parts 1,2,...': run each of those " +
  "entries of `parts`, in that order, one JavaScript call per part, exactly as given (each is a few KB). Each answers " +
  "'ok <name>' and the last answers {ok:true,...}. A 'corrupt ...' answer means the part changed in transit: run it " +
  "again exactly. If loaded_check lists a part this response does not include, call this tool again without " +
  "engine_loaded. On later calls in the same page pass engine_loaded = engine, so the parts are not sent again. " +
  "Loading is automatic and it is your job: never ask the user to paste code or open DevTools, and there is no " +
  "manual or API alternative. If your browser tool cannot run JavaScript on this page, tell the user that and stop.";

export function envelope(
  platform: EnginePlatform,
  cfg: { h: string },
  body: { steps: string[]; rules?: string[]; engineLoaded?: string; [k: string]: unknown }
) {
  const { steps, rules, engineLoaded, ...rest } = body;
  const e = engineParts(platform, cfg);
  const id = `${platform}@${e.version}.${cfg.h}`;
  // Same modules already in the page (only the config changed): send config + boot.
  const skip = engineLoaded === id ? e.parts.length : engineLoaded?.startsWith(`${platform}@${e.version}.`) ? e.moduleCount : 0;
  const parts = Object.fromEntries(e.parts.map((code, i) => [String(i + 1), code]).slice(skip));
  return {
    engine: id,
    ...rest,
    loaded_check: e.loadedCheck,
    ...(Object.keys(parts).length ? { parts } : {}),
    steps,
    ...(rules?.length ? { rules } : {}),
    paste_rule: PASTE_RULE,
  };
}
