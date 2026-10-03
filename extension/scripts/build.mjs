#!/usr/bin/env node
/**
 * Build the Chrome extension (BUILD-INSTRUCTIONS.md section 11.2):
 *   1. typecheck (extension/tsconfig.json: strict, DOM and chrome types, the shared contract)
 *   2. bundle with esbuild: background.js (esm), content.js and sidepanel.js (iife), minified
 *   3. copy the side panel page and styles, write manifest.json and the icons
 *   4. refuse any output with eval, new Function, or a URL host outside LinkedIn and Aupply
 *   5. zip dist/ to public/downloads/aupply-chrome.zip (Vite serves public/ as the site's root)
 *   6. write src/extension/version.ts when the manifest's version changed
 *
 * AUPPLY_EXT_BASE_URL points a dev build at another Aupply (for example http://localhost:5173);
 * its origin is then added to host_permissions. A production build never contains localhost.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import JSZip from "jszip";
import { iconPng } from "./icons.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const root = path.resolve(ext, "..");
const dist = path.join(ext, "dist");
const zipPath = path.join(root, "public", "downloads", "aupply-chrome.zip");
const versionFile = path.join(root, "src", "extension", "version.ts");

const PROD_BASE = "https://aupply.vercel.app";
const base = (process.env.AUPPLY_EXT_BASE_URL || PROD_BASE).replace(/\/+$/, "");
const baseUrl = new URL(base);
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const version = manifest.version;
const t0 = Date.now();

// 1. Typecheck.
execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", path.join(ext, "tsconfig.json"), "--noEmit"], { stdio: "inherit" });

// 2. Bundle.
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "icons"), { recursive: true });
const common = {
  bundle: true,
  minify: true,
  target: "chrome120",
  platform: "browser",
  legalComments: "none",
  define: {
    __AUPPLY_BASE_URL__: JSON.stringify(base),
    __EXT_VERSION__: JSON.stringify(version),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  logLevel: "warning",
};
await esbuild.build({ ...common, entryPoints: [path.join(ext, "src/background/index.ts")], outfile: path.join(dist, "background.js"), format: "esm" });
await esbuild.build({ ...common, entryPoints: [path.join(ext, "src/content/index.ts")], outfile: path.join(dist, "content.js"), format: "iife" });
await esbuild.build({ ...common, entryPoints: [path.join(ext, "src/sidepanel/main.tsx")], outfile: path.join(dist, "sidepanel.js"), format: "iife", jsx: "automatic" });

// 3. Static files, manifest, icons.
fs.copyFileSync(path.join(ext, "src/sidepanel/index.html"), path.join(dist, "sidepanel.html"));
fs.copyFileSync(path.join(ext, "src/sidepanel/styles.css"), path.join(dist, "styles.css"));
if (baseUrl.origin !== PROD_BASE) manifest.host_permissions = [...manifest.host_permissions, `${baseUrl.origin}/*`];
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(dist, "icons", `${size}.png`), iconPng(size));

// 4. No remote code: nothing that evaluates strings, and no URL host beyond LinkedIn and Aupply.
// Inert hosts that only appear inside library strings: XML namespaces (www.w3.org) and React's
// production error links (react.dev). Neither is ever fetched.
const INERT = new Set(["www.w3.org", "react.dev"]);
const hosts = new Set(["www.linkedin.com", "linkedin.com", baseUrl.host]);
const problems = [];
for (const f of ["background.js", "content.js", "sidepanel.js", "sidepanel.html", "manifest.json"]) {
  const s = fs.readFileSync(path.join(dist, f), "utf8");
  if (/\beval\s*\(/.test(s)) problems.push(`${f}: eval(`);
  if (/new\s+Function\s*\(/.test(s)) problems.push(`${f}: new Function`);
  for (const m of s.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const h = m[1].toLowerCase();
    if (!hosts.has(h) && !INERT.has(h)) problems.push(`${f}: URL host ${h}`);
  }
  if (baseUrl.origin === PROD_BASE && /localhost/.test(s)) problems.push(`${f}: localhost in a production build`);
}
if (problems.length) {
  console.error("build:extension refused the output:\n  " + [...new Set(problems)].join("\n  "));
  process.exit(1);
}

// 5. Zip.
const zip = new JSZip();
const addDir = (dir, prefix = "") => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) addDir(p, `${prefix}${name}/`);
    else zip.file(`${prefix}${name}`, fs.readFileSync(p));
  }
};
addDir(dist);
fs.mkdirSync(path.dirname(zipPath), { recursive: true });
fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

// 6. The version the server reports as latest.
const want = `// Written by extension/scripts/build.mjs from extension/manifest.json. Do not edit by hand.\nexport const EXT_VERSION = "${version}";\n`;
if (!fs.existsSync(versionFile) || fs.readFileSync(versionFile, "utf8") !== want) fs.writeFileSync(versionFile, want);

const kb = (f) => `${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)}KB`;
console.log(
  `build:extension ${version} for ${base}: background ${kb("background.js")}, content ${kb("content.js")}, sidepanel ${kb("sidepanel.js")}; ` +
    `zip ${(fs.statSync(zipPath).size / 1024).toFixed(0)}KB at ${path.relative(root, zipPath)} (${Date.now() - t0}ms)`
);
