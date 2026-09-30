/**
 * Browser engines, built by scripts/build-engines.mjs from src/engines/src.
 * engineScript() fills in the user's config; the result is what Claude pastes.
 */

import { CFG_PLACEHOLDER, ENGINES } from "./generated.js";

export type EnginePlatform = keyof typeof ENGINES;

export const engineVersion = (p: EnginePlatform) => ENGINES[p].version;

export function engineScript(p: EnginePlatform, cfg: object): string {
  const json = JSON.stringify({ ...cfg, v: ENGINES[p].version })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return ENGINES[p].source.split(CFG_PLACEHOLDER).join(json);
}
