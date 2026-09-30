/**
 * The response every platform tool returns: what to open, the script to paste, the
 * exact expressions to run, and what to report. Claude follows it step by step.
 */

import { engineScript, engineVersion, type EnginePlatform } from "../engines/index.js";

/** Where each engine caches itself for one-line re-loads (LinkedIn never: CSP blocks eval). */
const CACHE: Partial<Record<EnginePlatform, string>> = {
  naukri: "localStorage.getItem('__aupply_naukri')",
  wellfound: "sessionStorage.getItem('__aupply_wellfound')",
  indeed: "localStorage.getItem('__aupply_indeed')",
};

export function envelope(
  platform: EnginePlatform,
  cfg: { h: string },
  body: { steps: string[]; rules?: string[]; engineLoaded?: string; [k: string]: unknown }
) {
  const { steps, rules, engineLoaded, ...rest } = body;
  const v = engineVersion(platform);
  const id = `${v}.${cfg.h}`;
  const cache = CACHE[platform];
  return {
    engine: `${platform}@${id}`,
    ...rest,
    loaded_check: `window.__aupply?.v === '${v}' && window.__aupply?.h === '${cfg.h}'`,
    ...(cache ? { reload: `(s => s ? eval(s) : 'NO_CACHE')(${cache})` } : {}),
    // Pass engine_loaded: "<the id above>" on later calls in the same page to skip this.
    ...(engineLoaded === id ? {} : { inject: engineScript(platform, cfg) }),
    steps,
    ...(rules?.length ? { rules } : {}),
    paste_rule:
      "Paste `inject` as the browser tool's JavaScript source exactly as given; never eval it. It returns {ok:true}. " +
      (cache
        ? "On later pages run `reload` instead; if it returns NO_CACHE, or a v/h other than this engine's, paste `inject` again."
        : "It survives the whole queue because the runner moves between jobs without reloading the page."),
  };
}
