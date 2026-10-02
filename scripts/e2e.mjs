#!/usr/bin/env node
/**
 * End-to-end smoke test for the backend: OAuth connector flow, all MCP tools,
 * and the dashboard API, against a running server.
 *
 *   npm run e2e                                  # local server on :3100 (see below)
 *   E2E_BASE_URL=https://aupply.vercel.app npm run e2e   # production
 *
 * Local server for this test (issuer must equal the URL we call):
 *   MCP_BASE_URL=http://localhost:3100 PORT=3100 npx tsx src/server.ts
 *
 * Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (from .env).
 * Creates a throwaway user and OAuth clients, and deletes them at the end,
 * including on failure. It writes to whatever project SUPABASE_URL points at.
 */

import "dotenv/config";
import crypto from "node:crypto";
import vm from "node:vm";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "http://localhost:9999/callback";
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
function expect(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
}
const section = (title) => console.log(`\n# ${title}`);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
/** A bare page for loading engine parts in node: storage, a document with nothing on it. */
function stubPage() {
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const ctx = {
    setTimeout, clearTimeout, URL, localStorage: storage(), sessionStorage: storage(),
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, body: { innerText: "" }, documentElement: {}, title: "" },
    location: { href: "https://www.linkedin.com/jobs-tracker/", pathname: "/jobs-tracker/", host: "www.linkedin.com", search: "" },
    history: { pushState() {} }, MutationObserver: class { observe() {} },
  };
  ctx.window = ctx;
  return vm.createContext(ctx);
}

async function http(method, path, { token, json, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, init);
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, headers: res.headers, body };
}

let rpcId = 0;
async function mcp(token, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  // Stateless Streamable HTTP answers with a single SSE message.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  let body = null;
  try {
    body = JSON.parse(dataLine ? dataLine.slice(6) : text);
  } catch {}
  return { status: res.status, headers: res.headers, body };
}

async function tool(token, name, args = {}) {
  const res = await mcp(token, "tools/call", { name, arguments: args });
  const result = res.body?.result;
  let data = null;
  try {
    data = JSON.parse(result?.content?.[0]?.text ?? "null");
  } catch {
    data = result?.content?.[0]?.text;
  }
  // Code arrives as text blocks after the JSON, verbatim (nothing escaped).
  const blocks = (result?.content || []).slice(1).map((c) => c.text);
  return { status: res.status, isError: Boolean(result?.isError), data, blocks, raw: res.body };
}

const h31 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
/** "/*aupply linkedin@ver core*\/" -> "core"; "/*aupply loaded_check*\/" -> "loaded_check". */
const blockName = (b) => /^\/\*aupply (?:\S+@\S+ )?(\S+)\*\//.exec(b)?.[1];
const blockWith = (r, name) => r.blocks.find((b) => blockName(b) === name);

/** What Claude does with a page: run loaded_check, then ask load_engine with the answer and
    run each block it sends, until the engine is ready. Returns what happened. */
async function loadEngineIn(page, res, token) {
  const out = { answers: 0, sent: [], maxBytes: 0, ready: false, booted: null, error: null, bytes: 0 };
  let answer = vm.runInContext(blockWith(res, "loaded_check"), page);
  if (answer === "ok") return { ...out, ready: true, already: true };
  while (out.answers < 20) {
    const d = await tool(token, "load_engine", { engine: res.data.engine, page: answer });
    if (d.isError || d.data.stale || d.data.limit || d.data.blocked) { out.error = d.isError ? d.data : d.data; break; }
    if (d.data.ready) { out.ready = true; break; }
    out.answers++;
    const bytes = d.blocks.reduce((n, b) => n + b.length, 0);
    out.bytes += bytes;
    out.maxBytes = Math.max(out.maxBytes, bytes);
    out.batch = d.data;
    for (const b of d.blocks) {
      out.sent.push(blockName(b));
      answer = vm.runInContext(b, page);
      if (blockName(b) === "boot") { out.booted = JSON.parse(answer); out.ready = Boolean(out.booted.ok); }
    }
    if (out.booted) break;
  }
  return out;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Full authorization-code flow for a registered client; returns tokens + code. */
async function authorize(clientId, userToken, { exchange = true } = {}) {
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(8));
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "mcp",
    resource: RESOURCE,
  });
  const auth = await http("GET", `/authorize?${qs}`);
  const location = auth.headers.get("location") || "";
  const request = new URL(location, BASE).searchParams.get("request");
  const consent = await http("POST", "/api/oauth/consent", { token: userToken, json: { request, approve: true } });
  const callback = new URL(consent.body.redirectUrl);
  const code = callback.searchParams.get("code");
  const result = { auth, location, request, consent, callback, code, verifier, state };
  if (exchange) {
    result.token = await http("POST", "/token", {
      form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE },
    });
  }
  return result;
}

/** Minimal one-page PDF containing `text`, with a correct xref table. */
function makePdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => (pdf += `${String(o).padStart(10, "0")} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** Minimal .docx (Office Open XML) with one paragraph of `text`. */
async function makeDocx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  );
  return zip.generateAsync({ type: "uint8array" });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
const runTag = `e2e-${Date.now()}`;
let userId = null;
const clientIds = [];
const storagePaths = [];

async function main() {
  console.log(`E2E against ${BASE}`);

  section("Setup: throwaway user");
  const email = `${runTag}@example.com`;
  const password = b64url(crypto.randomBytes(18));
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  userId = created.data.user?.id;
  expect("create user", Boolean(userId), created.error);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  const userToken = signIn.data.session?.access_token;
  expect("sign in", Boolean(userToken), signIn.error);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${userToken}` } },
  });

  section("Discovery");
  const unauth = await mcp(null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  const www = unauth.headers.get("www-authenticate") || "";
  expect("POST /mcp without token -> 401", unauth.status === 401, unauth.status);
  expect("401 carries resource_metadata", www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), www);
  const prm = await http("GET", "/.well-known/oauth-protected-resource/mcp");
  expect("protected resource metadata", prm.status === 200 && prm.body.resource === RESOURCE, prm.body);
  const prmRoot = await http("GET", "/.well-known/oauth-protected-resource");
  expect("protected resource metadata (root alias)", prmRoot.status === 200 && prmRoot.body.resource === RESOURCE, prmRoot.body);
  const asm = await http("GET", "/.well-known/oauth-authorization-server");
  expect(
    "authorization server metadata",
    asm.status === 200 &&
      asm.body.issuer.replace(/\/$/, "") === BASE &&
      asm.body.registration_endpoint === `${BASE}/register` &&
      asm.body.code_challenge_methods_supported?.includes("S256"),
    asm.body
  );

  section("Dynamic client registration");
  const reg = await http("POST", "/register", {
    json: {
      client_name: `E2E ${runTag}`,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  const clientId = reg.body?.client_id;
  if (clientId) clientIds.push(clientId);
  expect("register public client", reg.status === 201 && clientId && !reg.body.client_secret, reg.body);
  const regConf = await http("POST", "/register", {
    json: { client_name: `E2E conf ${runTag}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" },
  });
  if (regConf.body?.client_id) clientIds.push(regConf.body.client_id);
  expect(
    "register confidential client, secret never expires",
    regConf.status === 201 && regConf.body.client_secret && regConf.body.client_secret_expires_at === 0,
    regConf.body
  );
  const regBad = await http("POST", "/register", {
    json: { client_name: `E2E bad ${runTag}`, redirect_uris: ["http://evil.example.com/cb"], token_endpoint_auth_method: "none" },
  });
  expect("reject non-https redirect_uri", regBad.status === 400, regBad.body);

  section("Authorization code + PKCE");
  const flowA = await authorize(clientId, userToken);
  expect("/authorize redirects to consent page", flowA.auth.status === 302 && flowA.location.startsWith(`${BASE}/oauth/consent?request=`), flowA.location);
  const details = await http("GET", `/api/oauth/authorization?request=${encodeURIComponent(flowA.request)}`, { token: userToken });
  expect("consent details", details.status === 200 && details.body.client.name === `E2E ${runTag}` && details.body.redirectHost === "localhost:9999", details.body);
  expect("consent returns code + state + iss", Boolean(flowA.code) && flowA.callback.searchParams.get("state") === flowA.state && flowA.callback.searchParams.get("iss") === asm.body.issuer, flowA.consent.body);
  expect("token exchange", flowA.token.status === 200 && flowA.token.body.access_token && flowA.token.body.refresh_token, flowA.token.body);
  const accessA = flowA.token.body.access_token;

  const badVerifier = await authorize(clientId, userToken, { exchange: false });
  const badEx = await http("POST", "/token", {
    form: { grant_type: "authorization_code", code: badVerifier.code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", client_id: clientId, redirect_uri: REDIRECT },
  });
  expect("wrong PKCE verifier rejected", badEx.status === 400 && badEx.body.error === "invalid_grant", badEx.body);
  const denied = await http("POST", "/api/oauth/consent", { token: userToken, json: { request: badVerifier.request, approve: false } });
  expect("deny redirects with access_denied", denied.status === 200 && new URL(denied.body.redirectUrl).searchParams.get("error") === "access_denied", denied.body);
  const tampered = await http("POST", "/api/oauth/consent", { token: userToken, json: { request: badVerifier.request + "x", approve: true } });
  expect("tampered request token rejected", tampered.status === 400, tampered.body);

  section("MCP session");
  const init = await mcp(accessA, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  expect("initialize with token", init.status === 200 && init.body?.result?.serverInfo?.name === "Aupply", init.body);
  expect("server instructions sent", (init.body?.result?.instructions || "").includes("start_session"), init.body?.result);
  expect("server instructions fit what Claude Code keeps (2048 characters)", (init.body?.result?.instructions || "").length <= 2000, (init.body?.result?.instructions || "").length);
  const list = await mcp(accessA, "tools/list", {});
  const toolNames = (list.body?.result?.tools || []).map((t) => t.name).sort();
  expect("27 tools listed", toolNames.length === 27 && toolNames.includes("load_engine"), toolNames);
  const gone = await mcp(accessA, "tools/call", { name: "log_run", arguments: {} });
  expect("a removed tool answers with how to recover, not a bare error", gone.status === 200 && gone.body?.result?.isError === true && /reconnect the Aupply connector/.test(gone.body.result.content?.[0]?.text ?? ""), gone.body);

  // The tools version: start_session's tv carries it, so a chat that loaded the tools before a change is told to reconnect.
  const tvOf = (l) => /"([0-9a-f]{8})"/.exec((l.body?.result?.tools || []).find((t) => t.name === "start_session")?.inputSchema?.properties?.tv?.description ?? "")?.[1];
  const toolsV = tvOf(list);
  expect("start_session's tv parameter carries an 8-character tools version, the same on every listing", Boolean(toolsV) && toolsV === tvOf(await mcp(accessA, "tools/list", {})), toolsV);
  const oldChat = await tool(accessA, "start_session", { client: "e2e", tv: "00000000" });
  expect("a start_session from a chat with other tools is refused with how to recover, and opens no run", oldChat.isError && /reconnect the Aupply connector/.test(String(oldChat.data)) && /out-of-date/.test(String(oldChat.data)), oldChat.data);

  let r = await tool(accessA, "get_pending_actions");
  expect("get_pending_actions (empty)", !r.isError && Array.isArray(r.data) && r.data.length === 0, r.data);
  r = await tool(accessA, "get_candidate_profile");
  expect("get_candidate_profile", !r.isError && r.data.profile?.id === userId, r.data);
  r = await tool(accessA, "get_preferences");
  expect("get_preferences", !r.isError && r.data.user_id === userId, r.data);
  r = await tool(accessA, "get_resume");
  expect("get_resume with none -> tool error", r.isError && /not found/i.test(String(r.data)), r.data);

  const run = await tool(accessA, "start_session", { client: "e2e", tv: toolsV });
  expect("start_session opens a run with platform state and no mail searches", !run.isError && run.data.run_id && run.data.platforms?.linkedin?.cap_left === 35 && run.data.inbox_queries === undefined, run.data);
  const runId = run.data?.run_id;
  expect("start_session flags setup_needed on an empty profile", run.data?.setup_needed?.some((g) => g.startsWith("preferences.desired_roles")) && run.data.next?.[0]?.includes("update_profile"), run.data?.setup_needed);

  r = await tool(accessA, "update_profile", {
    profile: { languages: ["English", "Telugu"] },
    experiences: [
      { company: "Acme", title: "Engineer", start_date: "2024-01-01", is_current: true },
      { company: "Beta", title: "Intern", start_date: "2023-01-01", end_date: "2023-06-30" },
    ],
    educations: [{ institution: "MLRIT", degree: "B.Tech" }],
  });
  expect("update_profile saves profile and lists", !r.isError && r.data.saved?.includes("profile.languages") && r.data.saved?.includes("work_experiences (2)") && r.data.missing?.length > 0, r.data);
  r = await tool(accessA, "update_profile", { experiences: [], educations: [] });
  r = await tool(accessA, "get_candidate_profile");
  expect("update_profile lists replace (empty clears)", !r.isError && !r.data.work_experiences && !r.data.educations && r.data.profile?.languages?.length === 2, r.data);
  r = await tool(accessA, "update_profile", { profile: { user_id: "x" } });
  expect("update_profile rejects unknown fields", r.isError, r.data);

  r = await tool(accessA, "check_applied", { platform: "linkedin", external_ids: ["4471873921"] });
  expect("check_applied before", !r.isError && r.data.new?.length === 1 && !r.data.known, r.data);
  r = await tool(accessA, "check_applied", {});
  expect("check_applied with no input -> tool error", r.isError, r.data);

  const logged = await tool(accessA, "log_application", {
    platform: "LinkedIn",
    external_id: "https://www.linkedin.com/jobs/view/backend-engineer-at-acme-4471873921/",
    company_name: "Acme Corp",
    job_title: "Backend Engineer",
    status: "unconfirmed",
    run_id: runId,
    salary_min: 1000000,
    salary_currency: "inr",
    questions: [{ question: "What is your notice period?", answer: "15 days", field_type: "text" }],
  });
  expect("log_application (normalises platform/currency)", !logged.isError && logged.data.platform === "linkedin" && logged.data.salary_currency === "INR" && logged.data.questions_logged === 1, logged.data);
  expect("applied_at stamped for unconfirmed", Boolean(logged.data?.applied_at), logged.data);
  const appId = logged.data?.id;
  r = await tool(accessA, "log_application", { platform: "linkedin", external_id: "4471873921", company_name: "Acme Corp", job_title: "Backend Engineer", status: "applied" });
  expect("log_application upserts same job", !r.isError && r.data.id === appId && r.data.status === "applied" && r.data.salary_min === 1000000, r.data);
  r = await tool(accessA, "log_application", { platform: "company_site", company_name: "Skipco", job_title: "Java Dev", status: "skipped", status_reason: "Java stack" });
  expect("log_application skip without external_id", !r.isError && r.data.status === "skipped", r.data);
  r = await tool(accessA, "log_application", { platform: "linkedin", company_name: "X", job_title: "Y", status: "bogus" });
  expect("invalid status rejected", r.isError || r.raw?.error, r.raw);

  r = await tool(accessA, "check_applied", { platform: "linkedin", external_ids: ["urn:li:jobPosting:4471873921", "4471873999"], companies: ["ACME CORP"] });
  expect("check_applied finds job (any id form) and company", !r.isError && r.data.known?.length === 1 && r.data.new?.length === 1 && r.data.companies?.[0]?.submitted === 1, r.data);

  r = await tool(accessA, "save_answer", { question: "What is your notice period?", answer: "15 days", key: "notice_period", confirmed_by_user: true });
  expect("save_answer confirmed", !r.isError && r.data.saved === true && r.data.answer.status === "confirmed", r.data);
  const answerId = r.data?.answer?.id;
  r = await tool(accessA, "save_answer", { question: "Notice period in days", answer: "Immediate", key: "notice_period" });
  expect("provisional does not overwrite confirmed", !r.isError && r.data.saved === false && r.data.answer.answer === "15 days", r.data);
  r = await tool(accessA, "save_answer", { question: "Are you willing to work night shifts?", answer: "Yes" });
  expect("save_answer provisional", !r.isError && r.data.answer.status === "provisional" && r.data.answer.source === "claude", r.data);
  r = await tool(accessA, "resolve_answers", {
    questions: [
      { q: "What is your notice period?" },
      { q: "Are you willing to work night shifts?", options: ["Yes", "No"] },
      { q: "Date of birth" },
      { q: "notice period" },
      { q: "Favourite colour?" },
    ],
  });
  const ra = r.data || [];
  expect(
    "resolve_answers: saved, option, protected, similar, unknown",
    !r.isError && ra[0]?.source === "saved" && ra[0]?.status === "confirmed" && ra[1]?.option === "Yes" && ra[1]?.status === "provisional" &&
      ra[2]?.status === "protected" && ["saved", "history"].includes(ra[3]?.source) && ra[4]?.status === "unknown",
    ra
  );

  r = await tool(accessA, "log_application", {
    platform: "naukri", external_id: "280926903708", company_name: "Beta", job_title: "Dev", status: "applied",
    questions: [{ question: "Notice period?", answer: "15 days", answer_id: answerId }],
  });
  const { data: usedAnswer } = await admin.from("answers").select("times_used").eq("id", answerId).single();
  expect("reused answer counted", !r.isError && usedAnswer?.times_used === 1, usedAnswer);

  r = await tool(accessA, "record_outcome", { company_name: "acme corp", type: "interview", action_required: true, source: "import", external_ref: "msg-1", subject: "Interview invite" });
  expect("record_outcome matched by company", !r.isError && r.data.matched_by === "company_name" && r.data.application?.stage === "interview", r.data);
  const eventId = r.data?.event?.id;
  r = await tool(accessA, "record_outcome", { company_name: "acme corp", type: "interview", source: "import", external_ref: "msg-1" });
  expect("record_outcome dedups by external_ref", !r.isError && r.data.duplicate === true && r.data.event.id === eventId, r.data);
  r = await tool(accessA, "record_outcome", { company_name: "Unknown Inc", type: "rejected" });
  expect("record_outcome without a match", !r.isError && r.data.event.application_id === undefined && r.data.matched_by === undefined, r.data);
  r = await tool(accessA, "get_pending_actions");
  expect("pending action listed with its application", !r.isError && r.data.length === 1 && r.data[0].application?.company_name === "Acme Corp", r.data);
  r = await tool(accessA, "complete_action", { event_id: eventId });
  expect("complete_action", !r.isError && r.data.action_done === true, r.data);
  r = await tool(accessA, "get_pending_actions");
  expect("no pending actions left", !r.isError && r.data.length === 0, r.data);

  r = await tool(accessA, "get_application_history", { status: ["applied"] });
  expect("get_application_history filter", !r.isError && r.data.total === 2, r.data);
  r = await tool(accessA, "get_application_stats");
  expect("get_application_stats", !r.isError && r.data.submitted === 2 && r.data.responded === 1 && r.data.by_status?.skipped === 1, r.data);
  r = await tool(accessA, "end_session", { run_id: runId, summary: "e2e", hurdles: "none" });
  expect("end_session closes the run with DB counts and no funnel", !r.isError && r.data.counts_by_platform?.linkedin?.applied === 1 && r.data.funnel_30d === undefined, r.data);

  section("Dashboard API");
  const noAuth = await http("GET", "/api/profile");
  expect("no session -> 401", noAuth.status === 401, noAuth.body);
  const clientTokenOnApi = await http("GET", "/api/profile", { token: accessA });
  expect("MCP token not accepted on /api", clientTokenOnApi.status === 401, clientTokenOnApi.body);
  let a = await http("PATCH", "/api/profile", { token: userToken, json: { full_name: "E2E User", timezone: "Asia/Kolkata", notice_period_days: 15, skills: ["Node.js"] } });
  expect("PATCH /api/profile", a.status === 200 && a.body.full_name === "E2E User", a.body);
  a = await http("PATCH", "/api/profile", { token: userToken, json: { timezone: "Mars/Olympus" } });
  expect("invalid timezone -> 400", a.status === 400, a.body);
  a = await http("PATCH", "/api/profile", { token: userToken, json: { id: "someone-else" } });
  expect("unknown field (id) -> 400", a.status === 400, a.body);
  a = await http("POST", "/api/experiences", { token: userToken, json: { company: "Livemindz", title: "Software Developer", start_date: "2026-03-01", is_current: true } });
  expect("POST /api/experiences", a.status === 201 && a.body.id, a.body);
  const expId = a.body?.id;
  a = await http("PATCH", `/api/experiences/${expId}`, { token: userToken, json: { title: "SDE" } });
  expect("PATCH /api/experiences/:id", a.status === 200 && a.body.title === "SDE", a.body);
  a = await http("POST", "/api/educations", { token: userToken, json: { institution: "MLRIT", degree: "B.Tech", grade: "8.6", grade_scale: "10" } });
  expect("POST /api/educations", a.status === 201, a.body);
  a = await http("GET", "/api/profile", { token: userToken });
  expect("GET /api/profile aggregates", a.status === 200 && a.body.work_experiences.length === 1 && a.body.educations.length === 1 && a.body.canonical_answers.length === 1, a.body);
  a = await http("PATCH", "/api/preferences", { token: userToken, json: { desired_roles: ["Backend Engineer"], min_salary: 800000, salary_currency: "INR", work_modes: ["remote", "hybrid"] } });
  expect("PATCH /api/preferences", a.status === 200 && a.body.min_salary === 800000, a.body);
  a = await http("GET", "/api/applications?status=applied,skipped&limit=10", { token: userToken });
  expect("GET /api/applications", a.status === 200 && a.body.total === 3, a.body);
  a = await http("GET", "/api/applications?q=acme", { token: userToken });
  expect("GET /api/applications search", a.status === 200 && a.body.total === 1, a.body);
  a = await http("GET", `/api/applications/${appId}`, { token: userToken });
  expect("GET /api/applications/:id with events + questions", a.status === 200 && a.body.events.length === 1 && a.body.questions.length === 1 && a.body.stage === "interview", a.body);
  a = await http("POST", `/api/applications/${appId}/events`, { token: userToken, json: { type: "offer", detail: "12 LPA" } });
  expect("POST event -> stage offer", a.status === 201 && a.body.application.stage === "offer", a.body);
  a = await http("GET", "/api/applications/stats", { token: userToken });
  expect("GET /api/applications/stats", a.status === 200 && a.body.by_stage?.offer === 1, a.body);
  a = await http("GET", "/api/applications/not-a-uuid", { token: userToken });
  expect("bad uuid -> 400", a.status === 400, a.body);
  a = await http("GET", `/api/applications/${crypto.randomUUID()}`, { token: userToken });
  expect("missing application -> 404", a.status === 404, a.body);
  a = await http("GET", "/api/answers?keyed=true", { token: userToken });
  expect("GET /api/answers?keyed=true", a.status === 200 && a.body.length === 1, a.body);
  a = await http("GET", "/api/answers/similar?q=night%20shift", { token: userToken });
  expect("GET /api/answers/similar", a.status === 200 && a.body[0]?.question?.includes("night"), a.body);
  a = await http("GET", "/api/runs", { token: userToken });
  expect("GET /api/runs", a.status === 200 && a.body.length === 1, a.body);
  a = await http("GET", "/api/events", { token: userToken });
  expect("GET /api/events", a.status === 200 && a.body.length === 3, a.body);
  a = await http("GET", "/api/nope", { token: userToken });
  expect("unknown /api route -> 404", a.status === 404, a.body);

  section("Resumes + storage");
  a = await http("POST", "/api/resumes", { token: userToken, json: { label: "Full-stack" } });
  expect("first resume becomes default", a.status === 201 && a.body.is_default === true, a.body);
  const resumeId = a.body?.id;
  a = await http("POST", `/api/resumes/${resumeId}/upload-url`, { token: userToken, json: { file_name: "My Resume.pdf" } });
  expect("upload URL", a.status === 200 && a.body.path?.startsWith(`${userId}/${resumeId}/`), a.body);
  const up = a.body;
  storagePaths.push(up.path);
  const upload = await userClient.storage.from("resumes").uploadToSignedUrl(up.path, up.token, makePdf("Suraj E2E Resume Node Postgres"), { contentType: "application/pdf" });
  expect("browser-style upload to signed URL", !upload.error, upload.error);
  a = await http("POST", `/api/resumes/${resumeId}/file`, { token: userToken, json: { path: up.path } });
  expect("finalize extracts PDF text", a.status === 200 && a.body.text_extracted && a.body.resume.content?.includes("Suraj E2E Resume"), a.body);
  a = await http("POST", `/api/resumes/${resumeId}/file`, { token: userToken, json: { path: `${crypto.randomUUID()}/x/y.pdf` } });
  expect("finalize rejects foreign path", a.status === 400, a.body);
  a = await http("GET", `/api/resumes/${resumeId}/download-url`, { token: userToken });
  expect("download URL", a.status === 200 && a.body.url, a.body);
  r = await tool(accessA, "get_resume");
  expect("get_resume returns extracted text", !r.isError && r.data.resume.content.includes("Suraj E2E Resume") && r.data.variants.length === 1, r.data);
  a = await http("POST", "/api/resumes", { token: userToken, json: { label: "AI/ML", content: "AI resume text", is_default: true } });
  const { data: defaults } = await admin.from("resumes").select("id").eq("user_id", userId).eq("is_default", true);
  expect("new default replaces old default", a.status === 201 && defaults?.length === 1 && defaults[0].id === a.body.id, defaults);
  r = await tool(accessA, "get_resume", { label: "full-stack" });
  expect("get_resume by label", !r.isError && r.data.resume.id === resumeId, r.data);

  // Replace the file with a DOCX: text is re-extracted and the old file removed.
  a = await http("POST", `/api/resumes/${resumeId}/upload-url`, { token: userToken, json: { file_name: "resume.docx" } });
  const docx = a.body;
  const docxUpload = await userClient.storage
    .from("resumes")
    .uploadToSignedUrl(docx.path, docx.token, await makeDocx("Word Resume TypeScript FastAPI"), {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  expect("upload DOCX", !docxUpload.error, docxUpload.error);
  a = await http("POST", `/api/resumes/${resumeId}/file`, { token: userToken, json: { path: docx.path, replace_content: true } });
  expect("DOCX text extracted and replaces PDF text", a.status === 200 && a.body.content_replaced && a.body.resume.content === "Word Resume TypeScript FastAPI", a.body);
  const { data: oldFile } = await admin.storage.from("resumes").list(`${userId}/${resumeId}`);
  expect("replaced file removed from storage", oldFile?.length === 1 && oldFile[0].name === "resume.docx", oldFile);

  section("Automation tools");
  r = await tool(accessA, "linkedin_draft", {});
  const draftRes = r;
  const draftJson = JSON.stringify(r.data);
  expect(
    "linkedin_draft carries no engine code, only the engine id, steps and a tiny loaded_check block",
    !r.isError && r.data.engine?.startsWith("linkedin_draft@") && r.blocks.length === 1 && blockName(r.blocks[0]) === "loaded_check" && r.blocks[0].length < 1000 &&
      !("parts" in r.data) && !draftJson.includes("__ap") && draftJson.length < 4500 && typeof r.data.load_rule === "string" && r.data.steps?.length === 6,
    { engine: r.data?.engine, blocks: r.blocks.length, json: draftJson.length }
  );
  const draftPage = stubPage();
  {
    const res = await loadEngineIn(draftPage, draftRes, accessA);
    expect("load_engine sends the draft engine in pieces and it boots", res.ready && res.booted?.ok && res.booted.fails?.length === 0 && res.answers >= 2 && res.maxBytes <= 32000, res);
    expect("the draft engine never receives the apply code", !res.sent.some((n) => /^(res_|li_dom|li_fill|li_job|li_main)/.test(n)) && res.sent.includes("li_sweep") && res.sent.includes("li_screen") && res.sent.at(-1) === "boot", res.sent);
    expect("loaded_check answers ok once the engine is loaded", vm.runInContext(blockWith(draftRes, "loaded_check"), draftPage) === "ok");
    const state = vm.runInContext("JSON.stringify([window.__ap.v,window.__ap.c,window.__ap.e])", draftPage);
    const ready = await tool(accessA, "load_engine", { engine: draftRes.data.engine, page: state });
    expect("a loaded page is sent nothing more", !ready.isError && ready.data.ready === true && ready.blocks.length === 0, ready.data);
    const first = await tool(accessA, "load_engine", { engine: draftRes.data.engine, page: "garbage" });
    const flip = (code) => { const at = code.indexOf("const f=") + 40; return code.slice(0, at) + (code[at] === "a" ? "b" : "a") + code.slice(at + 1); };
    const altered = (() => { try { return String(vm.runInContext(flip(first.blocks[0]), stubPage())); } catch (e) { return `THROW ${e.name}`; } })();
    expect("a part changed in transit refuses to run", /^corrupt part |^THROW SyntaxError/.test(altered), altered);
    expect("an unreadable page answer is treated as an empty page", !first.isError && first.data.blocks?.[0] === "core" && first.blocks.every((b) => b.length <= 9000), first.data);
  }
  {
    // The same config again: same id, still no code. A changed config: a new id, and only config and boot are sent.
    r = await tool(accessA, "linkedin_draft", {});
    expect("an unchanged config issues the same engine id", !r.isError && r.data.engine === draftRes.data.engine, r.data?.engine);
    const changed = await tool(accessA, "linkedin_draft", { keywords: ["Platform Engineer"] });
    expect("a changed config issues a new engine id", !changed.isError && changed.data.engine !== draftRes.data.engine && changed.data.engine.startsWith("linkedin_draft@"), changed.data?.engine);
    const res = await loadEngineIn(draftPage, changed, accessA);
    expect("a changed config sends only the config and boot parts to a page that has the modules", res.ready && res.sent.length >= 2 && res.sent.every((n) => /^config\d+$|^boot$/.test(n)), res.sent);
    const old = await tool(accessA, "load_engine", { engine: draftRes.data.engine });
    expect("an engine id the tool has replaced is stale", !old.isError && old.data.stale === true && old.blocks.length === 0, old.data);
    const bad = await tool(accessA, "load_engine", { engine: "nonsense" });
    expect("an unknown engine id is a tool error", bad.isError, bad.data);
    const other = await tool(accessA, "load_engine", { engine: "naukri@0000000000.00000000" });
    expect("an engine that was never issued is stale, not served", !other.isError && other.data.stale === true && other.blocks.length === 0, other.data);
  }
  {
    // Every other platform: issue, load in a fresh page, and on the platforms that cache, restore it without the server.
    const cases = [
      ["naukri_draft", "naukri", "localStorage", {}],
      ["wellfound_draft", "wellfound", "sessionStorage", {}],
      ["indeed_draft", "indeed", "localStorage", {}],
    ];
    for (const [toolName, platform, storage, args] of cases) {
      const t = await tool(accessA, toolName, args);
      const page = stubPage();
      const res = t.isError || !t.data?.engine ? { error: t.data } : await loadEngineIn(page, t, accessA);
      expect(`${toolName}: engine issued without code, loaded in pieces, booted`, !t.isError && t.data.engine?.startsWith(`${platform}@`) && t.blocks.length === 1 && res.ready && res.booted?.ok && res.booted.platform === platform && res.answers >= 2, { engine: t.data?.engine, res });
      const cached = page[storage].getItem(`__aupply_${platform}`);
      const fresh = stubPage();
      fresh[storage].setItem(`__aupply_${platform}`, cached ?? "");
      expect(`${toolName}: a new page restores the engine from its own cache and answers ok`, Boolean(cached) && vm.runInContext(blockWith(t, "loaded_check"), fresh) === "ok", String(cached).length);
    }
    // A backoff on a platform also stops its engine.
  }
  {
    // Deliveries are metered per user, engine and day: a page that keeps asking from nothing is refused.
    const t = await tool(accessA, "wellfound_draft", {});
    let served = 0, limited = null, calls = 0;
    for (; calls < 60 && !limited; calls++) {
      const d = await tool(accessA, "load_engine", { engine: t.data.engine });
      if (d.data.limit) limited = d; else served += d.blocks.reduce((n, b) => n + b.length, 0);
    }
    const again = await tool(accessA, "load_engine", { engine: t.data.engine });
    expect("engine deliveries are metered: a page that keeps asking from nothing is refused", limited && limited.blocks.length === 0 && again.data.limit === true && served > 0 && served < 600000, { calls, served, limited: limited?.data });
  }
  const liEngine = draftRes.data.engine;
  r = await tool(accessA, "queue_jobs", {
    platform: "linkedin",
    jobs: [{ id: "4471000001", t: "Backend Engineer", co: "Qco", w: "1h" }, { id: "https://www.linkedin.com/jobs/view/4471000002/", t: "SDE", co: "Rco", sm: ["Java"] }],
    skipped: [{ id: "4471000003", r: "DROP_YEARS", t: "Senior Dev", co: "Sco" }],
  });
  expect("queue_jobs queues, asks, skips", !r.isError && r.data.counts?.queued === 1 && r.data.ask_user?.[0]?.id === "4471000002" && r.data.counts.skipped === 1, r.data);
  r = await tool(accessA, "start_session", { client: "e2e", platforms: ["linkedin"] });
  expect("start_session raises a stack decision left unanswered", !r.isError && r.data.platforms?.linkedin?.ask_user?.[0]?.id === "4471000002" && r.data.platforms.linkedin.ask_user[0].wants?.[0] === "Java" && r.data.next.some((n) => n.includes("ask_user")), r.data?.platforms);
  r = await tool(accessA, "check_applied", { platform: "linkedin", external_ids: ["4471000001", "urn:li:jobPosting:4471000003", "4471000009"] });
  expect("check_applied sees queued and skipped jobs", !r.isError && r.data.new?.length === 1 && r.data.known.length === 2, r.data);
  r = await tool(accessA, "linkedin_apply", { from_queue: true });
  const applyRes = r;
  const runBlock = blockWith(r, "run");
  const queueJson = /runQueue\((\[\[.*\]\]),\{/.exec(runBlock ?? "")?.[1];
  const queueK = Number(/k:(-?\d+)/.exec(runBlock ?? "")?.[1]);
  expect(
    "linkedin_apply takes the queue, not undecided jobs, and sends it as a verbatim block with a checksum",
    !r.isError && r.data.jobs === 1 && r.data.engine.startsWith("linkedin@") && r.blocks.length === 2 && blockName(r.blocks[0]) === "loaded_check" && Boolean(queueJson) &&
      JSON.parse(queueJson)[0][0] === "4471000001" && queueK === h31(JSON.stringify(JSON.parse(queueJson))) && !JSON.stringify(r.data).includes("runQueue"),
    { engine: r.data?.engine, blocks: r.blocks.map(blockName), runBlock }
  );
  {
    // Drafted in this page already: only the apply parts are missing.
    const res = await loadEngineIn(draftPage, applyRes, accessA);
    expect("an apply after a draft in the same page gets only what is missing, never the draft code", res.ready && res.booted?.ok && !res.sent.some((n) => /^(core|pay|li_base|li_sweep|li_screen|li_dmain)$/.test(n)) && res.sent.includes("li_fill") && res.sent.includes("li_job") && res.sent.at(-1) === "boot" && res.answers >= 3, res.sent);
    const api = vm.runInContext("Object.keys(window.__aupply).sort().join()", draftPage);
    expect("the apply engine exposes the runner and not the draft calls", api.includes("runQueue") && !api.includes("sweep"), api);
    const wrong = vm.runInContext(runBlock.replace(/k:-?\d+/, "k:1"), draftPage);
    expect("a queue that does not match its checksum is refused by the page", String(wrong).startsWith("CORRUPT_QUEUE"), wrong);
    const fresh = stubPage();
    const all = await loadEngineIn(fresh, applyRes, accessA);
    expect("a fresh page loads the apply engine in pieces", all.ready && all.booted?.ok && all.answers >= 4 && all.sent.includes("res_api") && !all.sent.some((n) => /^li_(sweep|screen)$/.test(n)), all.sent);
    // 2 Oct: LinkedIn caches its engines in localStorage like the other platforms, so a new chat in the same browser loads nothing.
    const cachedLi = fresh.localStorage.getItem("__aupply_linkedin");
    const later = stubPage();
    later.localStorage.setItem("__aupply_linkedin", cachedLi ?? "");
    expect("a new LinkedIn page restores the apply engine from its own cache and answers ok", Boolean(cachedLi) && vm.runInContext(blockWith(applyRes, "loaded_check"), later) === "ok", String(cachedLi).length);
    // A cache left by an older deploy (another engine version, one module changed): the page does not say ok,
    // the server sends only what differs, and the cache is replaced by the new engine.
    const version = /^linkedin@([0-9a-f]+)\./.exec(applyRes.data.engine)?.[1] ?? "";
    // The cache holds the config with its checksum: change the version inside the config, then recompute the checksum.
    const oldVersion = "0".repeat(version.length);
    const staleCache = String(cachedLi)
      .split(version).join(oldVersion)
      .replace(/a\.v\.li_main="[^"]*"/, 'a.v.li_main="0000000000"')
      .replace(/window\.__apc=(.*);window\.__apk=-?\d+;/s, (_m, j) => `window.__apc=${JSON.stringify(JSON.parse(j))};window.__apk=${h31(JSON.stringify(JSON.parse(j)))};`);
    const oldPage = stubPage();
    oldPage.localStorage.setItem("__aupply_linkedin", staleCache);
    const check = vm.runInContext(blockWith(applyRes, "loaded_check"), oldPage);
    expect("a cache from an older engine version is restored but does not answer ok", Boolean(version) && staleCache !== cachedLi && staleCache.includes('a.v.li_main="0000000000"') && check !== "ok" && vm.runInContext("window.__aupply && window.__aupply.v", oldPage) === oldVersion, String(check).slice(0, 120));
    const upgraded = await loadEngineIn(oldPage, applyRes, accessA);
    expect("load_engine upgrades it with only what differs: the changed module, the config and the boot", upgraded.ready && upgraded.booted?.ok && upgraded.sent.includes("li_main") && upgraded.sent.at(-1) === "boot" && !upgraded.sent.some((n) => /^(core|pay|res_base|res_rules_a|res_rules_b|res_api|li_base|li_dom|li_fill|li_job)$/.test(n)), upgraded.sent);
    const newerPage = stubPage();
    newerPage.localStorage.setItem("__aupply_linkedin", oldPage.localStorage.getItem("__aupply_linkedin") ?? "");
    expect("the upgrade replaced the old cache: a later page restores the current engine and answers ok", vm.runInContext("window.__aupply.v", oldPage) === version && vm.runInContext(blockWith(applyRes, "loaded_check"), newerPage) === "ok", vm.runInContext("window.__aupply.v", oldPage));
  }
  r = await tool(accessA, "report_results", { platform: "linkedin", results: [{ id: "4471000001", r: "SENT", a: "att1", qa: [["Notice period?", "15"]] }, { id: "4471000001", r: "SENT", a: "att1" }] });
  expect("report_results records a result once", !r.isError && r.data.recorded?.length === 1 && r.data.recorded[0][2] === "applied", r.data);
  // How recent the LinkedIn jobs are: set once in start_session, followed by the queue and the draft searches.
  r = await tool(accessA, "queue_jobs", { platform: "linkedin", jobs: [{ id: "4471000010", t: "Node Developer", co: "Wco", w: "1w" }] });
  expect("queue_jobs queues a week-old posting", !r.isError && r.data.counts?.queued === 1, r.data);
  r = await tool(accessA, "start_session", { client: "e2e", platforms: ["linkedin"], posted_within: "1h" });
  expect("start_session holds posted_within and counts only the queue inside it", !r.isError && r.data.platforms?.linkedin?.posted_within === "1h" && r.data.platforms.linkedin.queued === 0, r.data?.platforms);
  r = await tool(accessA, "linkedin_apply", { from_queue: true });
  expect("the session's window leaves an older posting in the queue", !r.isError && r.data.nothing_to_apply === true, r.data);
  r = await tool(accessA, "linkedin_apply", { from_queue: true, posted_within: "1w" });
  expect("posted_within on the call takes it", !r.isError && r.data.jobs === 1 && r.data.posted_within === "1w", r.data);
  r = await tool(accessA, "linkedin_draft", {});
  expect("the draft searches the session's window", !r.isError && r.data.searching?.posted_within === "1h" && r.data.searching.windows?.join() === "1h", r.data?.searching);
  r = await tool(accessA, "linkedin_draft", { posted_within: "1w" });
  expect("a week sweeps the freshest windows first", !r.isError && r.data.searching?.windows?.join() === "1h,24h,1w", r.data?.searching);
  // Technology answers (the user lists Node.js): a far stack is No / 0, a learnable tool Yes, an industry asked once.
  r = await tool(accessA, "resolve_answers", {
    questions: [{ q: "How many years of work experience do you have with Java?" }, { q: "Are you familiar with Tailwind CSS?" }, { q: "Do you have FinTech domain experience?" }],
  });
  const tq = r.data || [];
  expect("technology answers: a far stack is 0, a learnable tool Yes, an industry asked", !r.isError && tq[0]?.answer === "0" && tq[1]?.answer === "Yes" && tq[2]?.status === "unknown" && tq[2]?.key === "domain.fintech", tq);
  // Not Easy Apply: a strong match is saved for the user to apply to by hand, a weak one skipped.
  r = await tool(accessA, "queue_jobs", { platform: "linkedin", jobs: [{ id: "4471000020", t: "Backend Engineer", co: "Strongco", w: "24h" }, { id: "4471000021", t: "Data Analyst", co: "Weakco", w: "24h" }] });
  expect("queue_jobs queues two jobs for the saved check", !r.isError && r.data.counts?.queued === 2, r.data);
  r = await tool(accessA, "report_results", { platform: "linkedin", results: [{ id: "4471000020", r: "NO_EASY_APPLY", a: "att20" }, { id: "4471000021", r: "NO_EASY_APPLY", a: "att21" }] });
  expect(
    "not Easy Apply: a strong match is saved, a weak one skipped",
    !r.isError && r.data.recorded?.find((x) => x[0] === "4471000020")?.[2] === "saved" && r.data.recorded?.find((x) => x[0] === "4471000021")?.[2] === "skipped" && r.data.next?.some((n) => n.includes("dashboard")),
    r.data
  );
  a = await http("GET", "/api/applications?status=saved", { token: userToken });
  const savedJob = a.body?.items?.find((x) => x.external_id === "4471000020");
  expect("the dashboard lists the saved job with its link", a.status === 200 && Boolean(savedJob?.job_url?.includes("4471000020")), a.body);
  r = await tool(accessA, "start_session", { client: "e2e", platforms: ["linkedin"] });
  const capBefore = r.data?.platforms?.linkedin?.cap_left;
  a = await http("POST", `/api/applications/${savedJob?.id}/apply`, { token: userToken });
  expect("Apply records the saved job as applied by the user", a.status === 200 && a.body.status === "applied" && a.body.applied_by === "user" && Boolean(a.body.applied_at), a.body);
  a = await http("POST", `/api/applications/${savedJob?.id}/apply`, { token: userToken });
  expect("only a saved job can be applied to by hand", a.status === 409, a.body);
  a = await http("GET", "/api/applications?status=applied,unconfirmed&sort=applied", { token: userToken });
  expect(
    "the tracker shows the manual apply first and the engine's submission as Aupply's",
    a.status === 200 && a.body.items?.[0]?.external_id === "4471000020" && a.body.items[0].applied_by === "user" && a.body.items.find((x) => x.external_id === "4471000001")?.applied_by === "aupply",
    a.body?.items?.slice(0, 3)
  );
  r = await tool(accessA, "start_session", { client: "e2e", platforms: ["linkedin"] });
  expect("a manual apply does not use the Easy Apply cap", !r.isError && typeof capBefore === "number" && r.data.platforms?.linkedin?.cap_left === capBefore, { before: capBefore, after: r.data?.platforms?.linkedin?.cap_left });
  r = await tool(accessA, "report_results", { platform: "linkedin", results: [{ id: "4471000002", r: "NO_MODAL", a: "att2" }] });
  expect("first NO_MODAL is retried", !r.isError && r.data.next?.some((n) => n.includes("Retry once")), r.data);
  r = await tool(accessA, "report_results", { platform: "linkedin", results: [{ id: "4471000009", r: "DAILY_LIMIT", a: "att3" }] });
  expect("DAILY_LIMIT stops LinkedIn", !r.isError && r.data.stopped?.scope === "linkedin", r.data);
  r = await tool(accessA, "linkedin_apply", { jobs: ["4471000009"] });
  expect("blocked platform refuses scripts", !r.isError && r.data.blocked === true, r.data);
  r = await tool(accessA, "load_engine", { engine: applyRes.data.engine });
  expect("a blocked platform's engine is not delivered either", !r.isError && r.data.blocked === true && r.blocks.length === 0, r.data);
  r = await tool(accessA, "log_application", { platform: "linkedin", external_id: "not-an-id", company_name: "X", job_title: "Y", status: "applied" });
  expect("non-canonical LinkedIn id rejected", r.isError, r.data);

  section("Refresh, revoke, replay");
  const refresh1 = await http("POST", "/token", { form: { grant_type: "refresh_token", refresh_token: flowA.token.body.refresh_token, client_id: clientId } });
  expect("refresh issues new tokens", refresh1.status === 200 && refresh1.body.refresh_token !== flowA.token.body.refresh_token, refresh1.body);
  const refreshOld = await http("POST", "/token", { form: { grant_type: "refresh_token", refresh_token: flowA.token.body.refresh_token, client_id: clientId } });
  expect("old refresh token rejected after rotation", refreshOld.status === 400, refreshOld.body);
  a = await http("GET", "/api/connections", { token: userToken });
  expect("GET /api/connections", a.status === 200 && a.body.length === 1 && a.body[0].client_name === `E2E ${runTag}`, a.body);
  const grantId = a.body?.[0]?.id;
  a = await http("DELETE", `/api/connections/${grantId}`, { token: userToken });
  expect("revoke connection", a.status === 204, a.body);
  r = await mcp(refresh1.body.access_token, "tools/list", {});
  expect("revoked grant's access token -> 401", r.status === 401, r.status);

  const flowB = await authorize(clientId, userToken);
  expect("second authorization", flowB.token.status === 200, flowB.token.body);
  const replay = await http("POST", "/token", {
    form: { grant_type: "authorization_code", code: flowB.code, code_verifier: flowB.verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect("replayed code rejected", replay.status === 400, replay.body);
  r = await mcp(flowB.token.body.access_token, "tools/list", {});
  expect("replay revokes the grant it minted", r.status === 401, r.status);

  const flowC = await authorize(clientId, userToken);
  const rev = await http("POST", "/revoke", { form: { token: flowC.token.body.refresh_token, client_id: clientId } });
  expect("/revoke", rev.status === 200, rev.body);
  r = await mcp(flowC.token.body.access_token, "tools/list", {});
  expect("revoked via /revoke -> 401", r.status === 401, r.status);
}

async function cleanup() {
  section("Cleanup");
  try {
    if (userId) {
      const { data: files } = await admin.storage.from("resumes").list(userId, { limit: 100 });
      for (const folder of files || []) {
        const { data: inner } = await admin.storage.from("resumes").list(`${userId}/${folder.name}`);
        const paths = (inner || []).map((f) => `${userId}/${folder.name}/${f.name}`);
        if (paths.length) await admin.storage.from("resumes").remove(paths);
      }
      const del = await admin.auth.admin.deleteUser(userId);
      console.log(del.error ? `  could not delete user: ${del.error.message}` : "  deleted user (cascade)");
    }
    if (clientIds.length) {
      await admin.from("oauth_clients").delete().in("id", clientIds);
      console.log(`  deleted ${clientIds.length} oauth clients`);
    }
  } catch (err) {
    console.log("  cleanup error:", err);
  }
}

try {
  await main();
} catch (err) {
  failures.push(`crashed: ${err?.message}`);
  console.error(err);
} finally {
  await cleanup();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}
