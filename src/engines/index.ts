/**
 * Browser engines, built by scripts/build-engines.mjs from src/engines/src/modules.
 *
 * Claude loads an engine as numbered parts, each pasted in its own browser-tool call:
 * the modules (built, cached per page by hash), then the user's config (made here, per
 * request), then the boot part that instantiates them. loaded_check tells Claude which
 * parts the page still needs; after the first load a call usually needs none.
 */

import { ENGINES, MODULES } from "./generated.js";

export type EnginePlatform = keyof typeof ENGINES;

/** Characters of config JSON per part (a part stays a few KB after escaping). */
const CONFIG_CHUNK = 5000;

export const engineVersion = (p: EnginePlatform) => ENGINES[p].version;

/** The checksum the boot part verifies the pasted config with (same as the page's). */
export function h31(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** A JavaScript string literal in plain ASCII, so nothing is mangled in transit. */
const jsString = (s: string) =>
  JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export interface EngineParts {
  version: string;
  /** Every part in load order: modules, then config, then boot. */
  parts: string[];
  /** Parts 1..moduleCount are modules (the same for every user and call). */
  moduleCount: number;
  /** Returns "ok", or "paste parts 1,2,..." for what this page still needs. */
  loadedCheck: string;
}

export function engineParts(p: EnginePlatform, cfg: { h: string }): EngineParts {
  const e = ENGINES[p];
  const json = JSON.stringify({ ...cfg, v: e.version });
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += CONFIG_CHUNK) chunks.push(json.slice(i, i + CONFIG_CHUNK));
  const config = chunks.map(
    (c, i) =>
      `(()=>{window.__apj=${i ? "window.__apj+" : ""}${jsString(c)};window.__apk=${i === chunks.length - 1 ? h31(json) : 0};` +
      `return"ok config ${i + 1}/${chunks.length}"})()`
  );
  const parts = [...e.modules.map((n) => MODULES[n].code), ...config, e.boot];
  const hashes = e.modules.map((n) => [n, MODULES[n].hash]);
  const ok = `const ok=()=>{const u=window.__aupply;return!!u&&u.v===${JSON.stringify(e.version)}&&u.h===${JSON.stringify(cfg.h)}};if(ok())return"ok";`;
  // Pages that allow eval re-load the engine from their own cache in this same call.
  const cache = e.cache ? `try{const s=${e.cache.storage}.getItem(${JSON.stringify(e.cache.key)});if(s){(0,eval)(s);if(ok())return"ok"}}catch(e){}` : "";
  const loadedCheck =
    `(()=>{${ok}${cache}const a=window.__ap,M=${JSON.stringify(hashes)},p=[];` +
    `M.forEach((m,i)=>{if(!(a&&a.v[m[0]]===m[1]))p.push(i+1)});for(let i=${e.modules.length + 1};i<=${parts.length};i++)p.push(i);` +
    `return"paste parts "+p.join(",")})()`;
  return { version: e.version, parts, moduleCount: e.modules.length, loadedCheck };
}
