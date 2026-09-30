/**
 * Browser engines, built by scripts/build-engines.mjs from src/engines/src/modules.
 *
 * The engine is Aupply's product, so it never leaves the server whole. A platform tool
 * issues an engine (src/services/engines.ts keeps the user's config) and hands Claude only
 * a loaded_check. Claude reports what its page holds, and load_engine answers with the
 * next few parts that page lacks, chosen by planLoad below: the modules (built, the same
 * for every user, skipped when the page already has them by hash), then the user's config
 * (made here, a plain object built in the page), then the boot part that instantiates
 * everything. Claude runs each part as its own browser-tool call and every part answers
 * with the page's state, which is what the next plan reads.
 */

import { ENGINES, MODULES } from "./generated.js";

export type EngineName = keyof typeof ENGINES;

export const isEngineName = (s: string): s is EngineName => Object.prototype.hasOwnProperty.call(ENGINES, s);
export const engineVersion = (n: EngineName) => ENGINES[n].version;

/** Characters of config statements per config part (a part stays a few KB with its wrapper). */
const CONFIG_PART = 6000;

/** The checksum every part verifies what Claude copied with (the same as the page's). */
export function h31(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** JSON as a plain-ASCII JavaScript expression, so nothing is mangled in transit. */
export const asciiJson = (v: unknown) =>
  JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const lit = asciiJson;

export interface Part {
  /** A module name, config1..n, or boot. */
  name: string;
  kind: "module" | "config" | "boot";
  code: string;
}

export interface EngineBuild {
  name: EngineName;
  version: string;
  h: string;
  /** What the page reports (window.__ap.c and .e) once this exact engine is loaded. */
  tag: string;
  modules: Part[];
  config: Part[];
  boot: Part;
  loadedCheck: string;
}

// ---------------------------------------------------------------------------
// Config parts
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function splitText(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let end = Math.min(s.length, i + size);
    const last = s.charCodeAt(end - 1);
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--; // never cut a surrogate pair
    out.push(s.slice(i, end));
    i = end;
  }
  return out.length ? out : [""];
}

/** Values shorter than this stay on one line. */
const ONE_LINE = 160;

/** Statements that rebuild `value` at `path`, one short statement per line where it can be
    split: a short value on one line, a longer array pushed element by element, a longer
    object key by key, a string longer than a part in slices. */
function statements(path: string, value: Json, limit: number, out: string[]): void {
  const json = lit(value);
  const container = value !== null && typeof value === "object";
  if (container ? json.length <= ONE_LINE : path.length + json.length + 1 <= limit) {
    out.push(`${path}=${json};`);
  } else if (Array.isArray(value)) {
    out.push(`${path}=[];`);
    let group: string[] = [];
    let size = 0;
    const flush = () => {
      if (group.length) out.push(`${path}.push(\n${group.join(",\n")}\n);`);
      group = [];
      size = 0;
    };
    value.forEach((el, index) => {
      const s = lit(el);
      if (s.length > limit) {
        flush();
        statements(`${path}[${index}]`, el, limit, out);
      } else {
        if (size + s.length + 2 > limit) flush();
        group.push(s);
        size += s.length + 2;
      }
    });
    flush();
  } else if (container) {
    out.push(`${path}={};`);
    for (const [k, v] of Object.entries(value as { [k: string]: Json })) statements(`${path}[${lit(k)}]`, v, limit, out);
  } else {
    const [first, ...rest] = splitText(value as string, Math.floor(limit / 7)); // a character can cost 6 once escaped
    out.push(`${path}=${lit(first)};`, ...rest.map((s) => `${path}+=${lit(s)};`));
  }
}

/** Same as the build script's: a part's checksum covers its function's text with line edges
    and blank lines ignored, so whitespace that changes in transit does not matter. */
const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

/** Same layout as the build script's parts: one short statement per line, the same for every part. */
const wrap = (fnSrc: string, label: string, body: string[]) =>
  [
    "(()=>{",
    `const f=${fnSrc};`,
    'const s=(""+f).split("\\n").map((l)=>l.trim()).filter(Boolean).join("\\n");',
    "let h=0;",
    "for(let i=0;i<s.length;i++)h=h*31+s.charCodeAt(i)|0;",
    `if(h!==${h31(norm(fnSrc))})return"corrupt part ${label}: run it again exactly as given";`,
    ...body,
    "})()",
  ].join("\n");

/**
 * The config as parts Claude runs in order. Each part builds its slice of window.__apc (a
 * plain object, not a JSON string inside JavaScript: nothing to unescape), one statement
 * per line, and checks its own text first, like a module. A part answers how far the config
 * got (window.__ap.c is "<tag>_<parts applied>", the bare tag once complete), so a config
 * can be sent over several answers and a part run out of order is refused. The last part
 * sets window.__apk, the checksum of the whole object, which the boot part verifies: a part
 * skipped or run twice cannot boot.
 */
function configParts(cfg: { h: string; v: string }): Part[] {
  // "__proto__" as a key would set a prototype instead of a value; answers keys are user text.
  const safe = JSON.parse(JSON.stringify(cfg, (k, v) => (k === "__proto__" ? undefined : v))) as { [k: string]: Json };
  const tag = `${cfg.v}-${cfg.h}`;
  const checksum = h31(JSON.stringify(safe));
  const all: string[] = [];
  for (const [k, v] of Object.entries(safe)) statements(`c[${lit(k)}]`, v, CONFIG_PART, all);
  const bodies: string[] = [];
  let cur = "";
  for (const st of all) {
    if (cur && cur.length + st.length + 1 > CONFIG_PART) {
      bodies.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + st;
  }
  bodies.push(cur);
  return bodies.map((body, i) => {
    const n = i + 1;
    const last = n === bodies.length;
    const fn = `function(c,a){\n${body}\n${last ? `window.__apk=${checksum};\n` : ""}a.c=${JSON.stringify(last ? tag : `${tag}_${n}`)};\n}`;
    const start =
      n === 1
        ? ["f(window.__apc={},a);"]
        : [`if(a.c!==${JSON.stringify(`${tag}_${n - 1}`)})return"config${n} needs config${n - 1} first: run the config blocks in order from config1";`, "f(window.__apc,a);"];
    const code = wrap(fn, `config${n}`, ["const a=window.__ap=window.__ap||{m:{},v:{}};", ...start, "return JSON.stringify([a.v,a.c||0,a.e||0]);"]);
    return { name: `config${n}`, kind: "config" as const, code };
  });
}

// ---------------------------------------------------------------------------
// The state check and the build
// ---------------------------------------------------------------------------

/** Answers "ok" when this exact engine is live in the page (re-loading it from the page's
    own cache first, where the platform allows eval); otherwise the page's state, which
    load_engine reads to pick the parts to send. It reveals nothing about the engine. */
function loadedCheck(name: EngineName, version: string, h: string): string {
  const cache = ENGINES[name].cache;
  const ok = `const ok=()=>{const u=window.__aupply;return!!u&&u.v===${JSON.stringify(version)}&&u.h===${JSON.stringify(h)}};if(ok())return"ok";`;
  const reload = cache ? `try{const s=${cache.storage}.getItem(${JSON.stringify(cache.key)});if(s){(0,eval)(s);if(ok())return"ok"}}catch(e){}` : "";
  return `(()=>{${ok}${reload}const a=window.__ap;return JSON.stringify(a?[a.v,a.c||0,a.e||0]:[{},0,0])})()`;
}

export function buildEngine(name: EngineName, cfg: { h: string }): EngineBuild {
  const e = ENGINES[name];
  return {
    name,
    version: e.version,
    h: cfg.h,
    tag: `${e.version}-${cfg.h}`,
    modules: e.modules.map((n) => ({ name: n, kind: "module" as const, code: MODULES[n].code })),
    config: configParts({ ...cfg, v: e.version }),
    boot: { name: "boot", kind: "boot" as const, code: e.boot },
    loadedCheck: loadedCheck(name, e.version, cfg.h),
  };
}

// ---------------------------------------------------------------------------
// What to send next
// ---------------------------------------------------------------------------

/** What a part or loaded_check answered: [module hashes, config tag, engine tag]. */
export interface PageState {
  m: Record<string, string>;
  c: string;
  e: string;
}

/** Reads the page's answer leniently: a browser tool may quote it, and a missing or
    mangled answer only means the page is treated as empty (more is sent, never less). */
export function parsePage(raw: string | undefined): PageState {
  const empty: PageState = { m: {}, c: "", e: "" };
  let v: unknown = (raw ?? "").trim();
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      const span = /\[[\s\S]*\]/.exec(v as string)?.[0];
      try {
        v = span ? JSON.parse(span) : null;
      } catch {
        return empty;
      }
    }
  }
  if (!Array.isArray(v)) return empty;
  const [m, c, e] = v;
  const hashes: Record<string, string> = {};
  if (m && typeof m === "object") for (const [k, x] of Object.entries(m)) if (typeof x === "string") hashes[k] = x;
  return { m: hashes, c: typeof c === "string" ? c : "", e: typeof e === "string" ? e : "" };
}

export type Plan =
  | { ready: true }
  | { ready: false; batch: Part[]; bytes: number; /** Parts still to come after this batch. */ left: number };

/**
 * The next batch: what this page lacks, in load order (missing modules, the rest of the
 * config, then boot). Module code is the engine itself, so it is capped tightly
 * (modules bytes) and an answer never holds every module of an engine; the user's config
 * and the boot part only count against the larger total. At least one part always goes
 * out. The boot part is only ever sent together with, or after, everything it needs, so
 * parts on their own do nothing.
 */
export function planLoad(b: EngineBuild, page: PageState, limits: { modules: number; total: number }): Plan {
  if (page.e === b.tag) return { ready: true };
  const applied = page.c === b.tag ? b.config.length : page.c.startsWith(`${b.tag}_`) ? Math.max(0, Math.min(b.config.length, Number(page.c.slice(b.tag.length + 1)) || 0)) : 0;
  const todo: Part[] = [
    ...b.modules.filter((m) => page.m[m.name] !== MODULES[m.name as keyof typeof MODULES].hash),
    ...b.config.slice(applied),
    b.boot,
  ];
  const batch: Part[] = [];
  let bytes = 0;
  let moduleBytes = 0;
  for (const p of todo) {
    const size = p.code.length;
    if (batch.length && (bytes + size > limits.total || (p.kind === "module" && moduleBytes + size > limits.modules))) break;
    batch.push(p);
    bytes += size;
    if (p.kind === "module") moduleBytes += size;
  }
  // Even a small engine is never sent in one answer: when a fresh page would get every
  // module at once, the last one (and what depends on it) waits for the next answer.
  const modulesIn = batch.filter((p) => p.kind === "module").length;
  if (modulesIn === b.modules.length) {
    batch.splice(modulesIn - 1);
    bytes = batch.reduce((n, p) => n + p.code.length, 0);
  }
  return { ready: false, batch, bytes, left: todo.length - batch.length };
}

/** Everything the engine is made of, for the delivery meter. */
export const fullSize = (b: EngineBuild) => [...b.modules, ...b.config, b.boot].reduce((s, p) => s + p.code.length, 0);
