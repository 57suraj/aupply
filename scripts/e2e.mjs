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
  return { status: res.status, isError: Boolean(result?.isError), data, raw: res.body };
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
  expect("server instructions sent", (init.body?.result?.instructions || "").includes("get_pending_actions"), init.body?.result);
  const list = await mcp(accessA, "tools/list", {});
  const toolNames = (list.body?.result?.tools || []).map((t) => t.name).sort();
  expect("13 tools listed", toolNames.length === 13, toolNames);

  let r = await tool(accessA, "get_pending_actions");
  expect("get_pending_actions (empty)", !r.isError && Array.isArray(r.data) && r.data.length === 0, r.data);
  r = await tool(accessA, "get_candidate_profile");
  expect("get_candidate_profile", !r.isError && r.data.profile?.id === userId, r.data);
  r = await tool(accessA, "get_preferences");
  expect("get_preferences", !r.isError && r.data.user_id === userId, r.data);
  r = await tool(accessA, "get_resume");
  expect("get_resume with none -> tool error", r.isError && /not found/i.test(String(r.data)), r.data);

  const run = await tool(accessA, "log_run", { client: "e2e" });
  expect("log_run opens a run", !run.isError && run.data.id, run.data);
  const runId = run.data?.id;

  r = await tool(accessA, "check_applied", { platform: "linkedin", external_ids: ["123"] });
  expect("check_applied before", !r.isError && !r.data.jobs, r.data);
  r = await tool(accessA, "check_applied", {});
  expect("check_applied with no input -> tool error", r.isError, r.data);

  const logged = await tool(accessA, "log_application", {
    platform: "LinkedIn",
    external_id: "123",
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
  r = await tool(accessA, "log_application", { platform: "linkedin", external_id: "123", company_name: "Acme Corp", job_title: "Backend Engineer", status: "applied" });
  expect("log_application upserts same job", !r.isError && r.data.id === appId && r.data.status === "applied" && r.data.salary_min === 1000000, r.data);
  r = await tool(accessA, "log_application", { platform: "wellfound", company_name: "Skipco", job_title: "Java Dev", status: "skipped", status_reason: "Java stack" });
  expect("log_application skip without external_id", !r.isError && r.data.status === "skipped", r.data);
  r = await tool(accessA, "log_application", { platform: "linkedin", company_name: "X", job_title: "Y", status: "bogus" });
  expect("invalid status rejected", r.isError || r.raw?.error, r.raw);

  r = await tool(accessA, "check_applied", { platform: "linkedin", external_ids: ["123", "999"], companies: ["ACME CORP"] });
  expect("check_applied finds job and company", !r.isError && r.data.jobs?.length === 1 && r.data.companies?.[0]?.submitted === 1, r.data);

  r = await tool(accessA, "save_answer", { question: "What is your notice period?", answer: "15 days", key: "notice_period", confirmed_by_user: true });
  expect("save_answer confirmed", !r.isError && r.data.saved === true && r.data.answer.status === "confirmed", r.data);
  const answerId = r.data?.answer?.id;
  r = await tool(accessA, "save_answer", { question: "Notice period in days", answer: "Immediate", key: "notice_period" });
  expect("provisional does not overwrite confirmed", !r.isError && r.data.saved === false && r.data.answer.answer === "15 days", r.data);
  r = await tool(accessA, "save_answer", { question: "Are you willing to work night shifts?", answer: "Yes" });
  expect("save_answer provisional", !r.isError && r.data.answer.status === "provisional" && r.data.answer.source === "claude", r.data);
  r = await tool(accessA, "find_answers", { question: "notice period" });
  const sources = new Set((r.data || []).map((a) => a.source));
  expect("find_answers returns saved + history", !r.isError && sources.has("saved") && sources.has("history"), r.data);

  r = await tool(accessA, "log_application", {
    platform: "naukri", external_id: "n-1", company_name: "Beta", job_title: "Dev", status: "applied",
    questions: [{ question: "Notice period?", answer: "15 days", answer_id: answerId }],
  });
  const { data: usedAnswer } = await admin.from("answers").select("times_used").eq("id", answerId).single();
  expect("reused answer counted", !r.isError && usedAnswer?.times_used === 1, usedAnswer);

  r = await tool(accessA, "record_outcome", { company_name: "acme corp", type: "interview", action_required: true, source: "gmail", external_ref: "msg-1", subject: "Interview invite" });
  expect("record_outcome matched by company", !r.isError && r.data.matched_by === "company_name" && r.data.application?.stage === "interview", r.data);
  const eventId = r.data?.event?.id;
  r = await tool(accessA, "record_outcome", { company_name: "acme corp", type: "interview", source: "gmail", external_ref: "msg-1" });
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
  r = await tool(accessA, "log_run", { run_id: runId, summary: "e2e", stats: { linkedin: 1 }, ended: true });
  expect("log_run closes the run", !r.isError && r.data.ended_at, r.data);

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
