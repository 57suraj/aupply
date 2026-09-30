#!/usr/bin/env node
/**
 * Build the browser engines served by the platform tools.
 *
 *   node scripts/build-engines.mjs        (also runs as part of `npm run build`)
 *
 * An engine is a list of modules (src/engines/src/modules/<name>.js, one factory each)
 * plus a boot part. Claude pastes each module as its own small part: a browser tool will
 * not take a 36KB script in one call (live test, 30 Sep), and a part that changed in
 * transit refuses to register because it checks its own checksum. The user's config
 * travels in separate parts made per request (src/engines/index.ts).
 *
 * Checks, so a broken engine never ships (applix lost a run to one that did not parse):
 * every part parses and stays under PART_MAX; every name a module uses is declared, a
 * destructured import, or an allowlisted browser global; and every platform boots in a
 * stub page (selfTest passes, every module input is provided by an earlier module, the
 * page cache re-boots on its own). Writes src/engines/generated.ts (committed).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transform } from "esbuild";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modDir = join(root, "src/engines/src/modules");
const PART_MAX = 8000;

const SHARED = ["core", "res_base", "res_rules_a", "res_rules_b", "res_api"];
const PLATFORMS = {
  linkedin: { source: "LinkedIn", modules: ["li_dom", "li_fill", "li_draft", "li_main"], cache: null },
  naukri: { source: "Naukri", modules: ["nk_chat", "nk_main"], cache: { storage: "localStorage", key: "__aupply_naukri" } },
  wellfound: { source: "Wellfound", modules: ["wf_apply", "wf_main"], cache: { storage: "sessionStorage", key: "__aupply_wellfound" } },
  indeed: { source: "Indeed", modules: ["in_fill", "in_main"], cache: { storage: "localStorage", key: "__aupply_indeed" } },
};
/* The only browser globals a module may use. Anything else is a missing declaration or
   import (a lib.dom global such as `status` would otherwise hide a forgotten import). */
const BROWSER_GLOBALS = ["window", "document", "location", "history", "localStorage", "sessionStorage", "fetch", "URL", "setTimeout",
  "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "PopStateEvent", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement"];

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const h31 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const fail = (msg) => { console.error(`build-engines: ${msg}`); process.exit(1); };

/** Minify one function (source text of a function declaration or expression). */
async function minifyFn(src, label) {
  const { code } = await transform(`__F__=${src}`, { minify: true, target: "chrome100", charset: "ascii", legalComments: "none" });
  const out = code.trim();
  if (!out.startsWith("__F__=function") || !out.endsWith(";")) fail(`${label}: unexpected minifier output`);
  return out.slice("__F__=".length, -1);
}

/* A part runs its function's checksum before doing anything, so a character dropped or
   changed while Claude pastes it is caught instead of misbehaving on a live form. */
const guard = (fnSrc, label) =>
  `const f=${fnSrc},s=""+f;let h=0;for(let i=0;i<s.length;i++)h=h*31+s.charCodeAt(i)|0;` +
  `if(h!==${h31(fnSrc)})return"corrupt part ${label}: run it again exactly as given";`;

function checkPart(code, label) {
  new vm.Script(code, { filename: label });
  if (code.length > PART_MAX) fail(`${label} is ${code.length} bytes (max ${PART_MAX}): split the module`);
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const names = [...SHARED, ...Object.values(PLATFORMS).flatMap((p) => p.modules)];
const sources = {};
const modules = {};
for (const name of names) {
  const src = readFileSync(join(modDir, `${name}.js`), "utf8");
  if (!new RegExp(`^function ${name}\\(X\\) \\{$`, "m").test(src)) fail(`${name}.js must define function ${name}(X)`);
  new vm.Script(src, { filename: `${name}.js` });
  sources[name] = src;
  const fn = await minifyFn(src.slice(src.indexOf(`function ${name}(X)`)), name);
  const hash = sha(fn);
  const code = `(()=>{${guard(fn, name)}const a=window.__ap=window.__ap||{m:{},v:{}};a.m.${name}=f;a.v.${name}="${hash}";return"ok ${name}"})()`;
  checkPart(code, name);
  modules[name] = { hash, code };
}

// Every identifier must resolve to a local, a destructured import or an allowlisted
// global. TypeScript does the scope analysis; only "cannot find name" counts.
{
  const files = new Map(names.map((n) => [resolve("/virtual", `${n}.js`), `export {};\n${sources[n]}`]));
  files.set(resolve("/virtual/globals.d.ts"), `declare var ${BROWSER_GLOBALS.map((g) => `${g}: any`).join(", ")};`);
  const options = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, lib: ["lib.es2022.d.ts"], types: [], skipLibCheck: true };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (f, lang, ...rest) => (files.has(f) ? ts.createSourceFile(f, files.get(f), lang, true) : getSourceFile(f, lang, ...rest));
  host.fileExists = (f) => files.has(f) || fileExists(f);
  const program = ts.createProgram([...files.keys()], options, host);
  const errs = ts.getPreEmitDiagnostics(program).filter((d) => d.code === 2304 || d.code === 2552);
  if (errs.length) {
    fail("undeclared names (declare them, import them from X, or allowlist a browser global):\n" +
      errs.map((d) => { const { line } = d.file.getLineAndCharacterOfPosition(d.start); return `  ${d.file.fileName.replace("/virtual/", "")}:${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`; }).join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Boot parts: instantiate the modules with the config parts' CFG, cache for re-loads
// ---------------------------------------------------------------------------

const bootSource = (list, source, cache) => `function B(){
  var a=window.__ap,u=window.__aupply,j=window.__apj;
  if(!a||typeof j!=="string")return JSON.stringify({ok:false,error:"missing parts: run loaded_check and paste every part it lists, in order"});
  var h=0;for(var i=0;i<j.length;i++)h=h*31+j.charCodeAt(i)|0;
  if(h!==window.__apk)return JSON.stringify({ok:false,error:"corrupt config: run the config parts again exactly as given, then this one"});
  var CFG=JSON.parse(j);
  if(u&&u.running&&u.running()&&(u.v!==CFG.v||u.h!==CFG.h))return JSON.stringify({ok:false,error:"RUNNING: a script is live in this page; wait for it to finish, then load again"});
  var M=${JSON.stringify(list)},miss=M.filter(function(n){return!a.m[n]});
  if(miss.length)return JSON.stringify({ok:false,missing:miss});
  var X={CFG:CFG,SOURCE:${JSON.stringify(source)}};
  for(var n of M){var e=a.m[n](X);for(var k in e){if(k in X)return JSON.stringify({ok:false,error:"duplicate "+k+" in "+n});X[k]=e[k]}}
  ${cache ? `try{${cache.storage}.setItem(${JSON.stringify(cache.key)},"(()=>{const a=window.__ap=window.__ap||{m:{},v:{}};"+M.map(function(n){return"a.m."+n+"="+a.m[n]+";a.v."+n+"="+JSON.stringify(a.v[n])+";"}).join("")+"})();window.__apj="+JSON.stringify(j)+";window.__apk="+h+";("+B+")()")}catch(e){}` : ""}
  return X.ret;
}`;

const engines = {};
for (const [platform, p] of Object.entries(PLATFORMS)) {
  const list = [...SHARED, ...p.modules];
  const fn = await minifyFn(bootSource(list, p.source, p.cache), `${platform} boot`);
  const boot = `(()=>{${guard(fn, "boot")}return f()})()`;
  checkPart(boot, `${platform} boot`);
  const version = sha(list.map((n) => modules[n].hash).join(".") + "." + sha(boot));
  engines[platform] = { version, source: p.source, modules: list, boot, cache: p.cache };
}

// ---------------------------------------------------------------------------
// Boot every platform in a stub page, the way Claude loads it
// ---------------------------------------------------------------------------

function stubPage() {
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const el = { style: { setProperty() {} } };
  const ctx = {
    setTimeout, clearTimeout, URL,
    localStorage: storage(), sessionStorage: storage(),
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, body: { innerText: "", scrollHeight: 0 }, documentElement: el, title: "" },
    location: { href: "https://example.invalid/", pathname: "/", host: "example.invalid", search: "" },
    history: { pushState() {} },
    MutationObserver: class { observe() {} },
    fetch: async () => ({ ok: false, status: 0, text: async () => "" }),
  };
  ctx.window = ctx;
  return vm.createContext(ctx);
}
const API = {
  linkedin: ["sweep", "prescreen", "runQueue", "resume", "stop", "tracker"],
  naukri: ["scrape", "draft", "go", "finish"],
  wellfound: ["scrape", "draft", "apply"],
  indeed: ["scrape", "draft", "drive", "jk"],
};
for (const [platform, e] of Object.entries(engines)) {
  const cfg = {
    u: "build000", v: e.version, h: "cafe0000",
    me: { fullName: "Test User", firstName: "Test", city: "Pune", country: "India", years: 2, skills: ["React", "Node.js"], noticeDays: 30, ctcCurrent: 600000, ctcExpected: 1000000, degree: "B.Tech" },
    // A saved answer to a self-test question must not fail the self-test.
    keyed: { notice_period: "30" }, saved: [["What is your notice period?", "30 days"]], overrides: [["Date of birth", "skip"]], policy: { tech: "yes" },
    screen: { negTitle: "\\bsenior\\b", maxYears: 3, minPay: 500000, keywords: [["Backend Engineer", 3]], windows: ["r3600"], stack: [] },
  };
  const page = stubPage();
  for (const n of e.modules) {
    const r = vm.runInContext(modules[n].code, page, { filename: n });
    if (r !== `ok ${n}`) fail(`${platform}: part ${n} answered ${r}`);
  }
  const j = JSON.stringify(cfg);
  page.window.__apj = j;
  page.window.__apk = h31(j);
  const out = JSON.parse(vm.runInContext(e.boot, page, { filename: `${platform} boot` }));
  if (!out.ok || out.fails?.length) fail(`${platform}: boot answered ${JSON.stringify(out)}`);
  const api = page.window.__aupply;
  for (const k of ["status", "wait", "running", "all", "selfTest", ...API[platform]]) if (typeof api[k] !== "function") fail(`${platform}: __aupply.${k} is not a function`);
  JSON.parse(api.status());

  // Every name a module reads from X must come from an earlier module.
  const X = new Proxy({ CFG: cfg, SOURCE: e.source }, { get(t, k) { if (typeof k === "string" && !(k in t)) throw new Error(`reads X.${k}, which no earlier module provides`); return t[k]; } });
  for (const n of e.modules) {
    let exp;
    try { exp = page.window.__ap.m[n](X); } catch (err) { fail(`${platform}: module ${n} ${err.message}`); }
    for (const k of Object.keys(exp)) { if (k in X) fail(`${platform}: module ${n} returns ${k}, which an earlier module already provides`); X[k] = exp[k]; }
  }

  if (e.cache) {
    const cached = page.window[e.cache.storage].getItem(e.cache.key);
    if (!cached) fail(`${platform}: boot wrote no cache`);
    const fresh = stubPage();
    const again = JSON.parse(vm.runInContext(`(0,eval)(${JSON.stringify(cached)})`, fresh));
    if (!again.ok || fresh.window.__aupply?.v !== e.version) fail(`${platform}: the cached engine does not re-boot: ${JSON.stringify(again)}`);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

for (const [platform, e] of Object.entries(engines)) {
  const sizes = e.modules.map((n) => (modules[n].code.length / 1024).toFixed(1));
  const total = e.modules.reduce((s, n) => s + modules[n].code.length, e.boot.length);
  console.log(`${platform.padEnd(10)} ${e.version}  ${e.modules.length + 1} parts, ${(total / 1024).toFixed(1)}KB (largest ${Math.max(...sizes.map(Number)).toFixed(1)}KB)`);
}

const lit = (v) => JSON.stringify(v);
writeFileSync(
  join(root, "src/engines/generated.ts"),
  `// Generated by scripts/build-engines.mjs from src/engines/src/modules. Do not edit by hand.\n\n` +
    `/** One pasteable part per module: registers window.__ap.m[name] after checking itself. */\n` +
    `export const MODULES = {\n${names.map((n) => `  ${n}: { hash: ${lit(modules[n].hash)}, code: ${lit(modules[n].code)} },`).join("\n")}\n} as const;\n\n` +
    `/** Per platform: the modules in load order and the boot part that instantiates them. */\n` +
    `export const ENGINES = {\n${Object.entries(engines).map(([p, e]) => `  ${p}: {\n    version: ${lit(e.version)},\n    source: ${lit(e.source)},\n    modules: ${lit(e.modules)},\n    boot: ${lit(e.boot)},\n    cache: ${lit(e.cache)},\n  },`).join("\n")}\n} as const;\n\n` +
    `/** The resolver's modules, evaluated server-side by src/platforms/resolver.ts. */\n` +
    `export const RESOLVER_MODULES = ${lit(SHARED)} as const;\n`
);
