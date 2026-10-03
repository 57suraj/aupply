#!/usr/bin/env node
/**
 * End-to-end suite for the Chrome extension channel (/ext/v1), against a running server.
 *
 *   npm run e2e:ext                                         # local server on :3101 (see below)
 *   E2E_EXT_BASE_URL=https://aupply.vercel.app npm run e2e:ext   # production (cron check needs CRON_SECRET)
 *
 * Local server for this test (the issuer must equal the URL we call):
 *   MCP_BASE_URL=http://localhost:3101 EXT_PORT=3101 AI_FAKE=1 EXT_MIN_VERSION=0.1.0 \
 *     CRON_SECRET=e2e-cron-secret npx tsx src/extension/server/dev.ts
 *
 * Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (from .env). Creates a
 * throwaway user (invented data only) and deletes it at the end, including on failure, which
 * also proves no ext_ table blocks account deletion. It writes to whatever project
 * SUPABASE_URL points at.
 */

import "dotenv/config";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

const BASE = (process.env.E2E_EXT_BASE_URL || "http://localhost:3101").replace(/\/+$/, "");
const API = `${BASE}/ext/v1`;
const CRON_SECRET = process.env.E2E_CRON_SECRET || process.env.CRON_SECRET || "e2e-cron-secret";
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Tiny assertion harness (same shape as scripts/e2e.mjs)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
let VERSION = "0.1.0";
/** Every response body seen, to prove first_seen_by never leaves the server. */
const seenBodies = [];

async function http(method, path, { token, json, headers = {}, version = VERSION } = {}) {
  const init = { method, headers: { ...headers } };
  if (version) init.headers["X-Aupply-Ext-Version"] = version;
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, init);
  const text = await res.text();
  seenBodies.push(text);
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body };
}
const code = (r) => r.body?.error?.code;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const runTag = `e2e-ext-${Date.now()}`;
let userId = null;
const pairIds = [];

/** Pair a new device for the user: start, approve on the "website", poll for tokens. */
async function pairDevice(userToken, name = "E2E Chrome") {
  const start = await http("POST", "/pair/start", { json: { device_name: name, ext_version: VERSION } });
  if (start.body?.pair_id) pairIds.push(start.body.pair_id);
  const ok = await http("POST", `/web/pair/${start.body.user_code}`, { token: userToken, json: { approve: true } });
  await sleep(2100);
  const poll = await http("POST", "/pair/poll", { json: { pair_id: start.body.pair_id, poll_secret: start.body.poll_secret } });
  return {
    start, ok, poll,
    deviceId: poll.body?.device?.id,
    access: poll.body?.tokens?.access_token,
    refresh: poll.body?.tokens?.refresh_token,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
async function main() {
  console.log(`E2E (extension) against ${API}`);

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

  // -------------------------------------------------------------------------
  section("1. Health and the version gate");
  let r = await http("GET", "/health", { version: null });
  expect("GET /health is JSON", r.status === 200 && r.body?.ok === true && /^\d+\.\d+\.\d+$/.test(r.body.version), r.body);
  VERSION = r.body?.version ?? VERSION;
  const min = r.body?.min_ext_version ?? "0.0.0";
  expect("server runs with a minimum version (EXT_MIN_VERSION set)", min !== "0.0.0", r.body);
  r = await http("GET", "/me", { version: null });
  expect("no version header -> 426", r.status === 426 && code(r) === "upgrade_required" && r.body.error.min_version === min && r.body.error.download_url, r.body);
  r = await http("GET", "/me", { version: "0.0.1" });
  expect("old version -> 426", r.status === 426 && code(r) === "upgrade_required", r.body);
  r = await http("GET", "/me", { version: VERSION });
  expect("current version passes the gate (then 401 without a token)", r.status === 401 && code(r) === "unauthorized", r.body);
  r = await http("GET", "/nope", { version: null });
  expect("unknown path -> 404 JSON", r.status === 404 && code(r) === "not_found", r.body);

  // -------------------------------------------------------------------------
  section("2. Pairing");
  const s1 = await http("POST", "/pair/start", { json: { device_name: "E2E Chrome on macOS", ext_version: VERSION } });
  if (s1.body?.pair_id) pairIds.push(s1.body.pair_id);
  expect(
    "pair/start",
    s1.status === 200 && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(s1.body.user_code) && s1.body.verify_url.endsWith(`/extension/connect?code=${s1.body.user_code}`) && s1.body.interval_s === 3,
    s1.body
  );
  r = await http("POST", "/pair/start", { json: { device_name: "" } });
  expect("pair/start validates", r.status === 400 && code(r) === "invalid_request", r.body);
  const poll1 = () => http("POST", "/pair/poll", { json: { pair_id: s1.body.pair_id, poll_secret: s1.body.poll_secret } });
  r = await poll1();
  expect("poll: pending", r.status === 200 && r.body.status === "pending", r.body);
  r = await poll1();
  expect("poll again at once -> 429 slow_down", r.status === 429 && code(r) === "slow_down" && r.body.error.retry_after_s > 0, r.body);
  r = await http("POST", "/pair/poll", { json: { pair_id: s1.body.pair_id, poll_secret: "x".repeat(43) } });
  expect("poll with a wrong secret -> 404", r.status === 404, r.body);
  r = await http("GET", `/web/pair/${s1.body.user_code}`);
  expect("web pair info needs a session", r.status === 401, r.body);
  r = await http("GET", `/web/pair/${s1.body.user_code.toLowerCase().replace("-", "")}`, { token: userToken });
  expect("web pair info (code typed in any case, no dash)", r.status === 200 && r.body.status === "pending" && r.body.device_name === "E2E Chrome on macOS", r.body);
  r = await http("POST", `/web/pair/${s1.body.user_code}`, { token: userToken, json: { approve: true } });
  const dev1 = r.body?.device?.id;
  expect("approve", r.status === 200 && r.body.status === "approved" && dev1, r.body);
  r = await http("POST", `/web/pair/${s1.body.user_code}`, { token: userToken, json: { approve: true } });
  expect("approve again is idempotent", r.status === 200 && r.body.device?.id === dev1, r.body);
  await sleep(2100);
  r = await poll1();
  expect("poll returns tokens once", r.status === 200 && r.body.status === "approved" && r.body.device.id === dev1 && r.body.tokens?.access_token && r.body.tokens.refresh_token?.startsWith("aext_"), r.body?.status);
  let access = r.body?.tokens?.access_token;
  let refresh = r.body?.tokens?.refresh_token;
  await sleep(2100);
  r = await poll1();
  expect("poll after collection -> expired", r.status === 200 && r.body.status === "expired", r.body);
  r = await http("GET", `/web/pair/${s1.body.user_code}`, { token: userToken });
  expect("a collected code is gone from the website", r.status === 404, r.body);

  const s2 = await http("POST", "/pair/start", { json: { device_name: "E2E deny" } });
  if (s2.body?.pair_id) pairIds.push(s2.body.pair_id);
  r = await http("POST", `/web/pair/${s2.body.user_code}`, { token: userToken, json: { approve: false } });
  expect("deny", r.status === 200 && r.body.status === "denied", r.body);
  r = await http("POST", "/pair/poll", { json: { pair_id: s2.body.pair_id, poll_secret: s2.body.poll_secret } });
  expect("poll after deny -> denied", r.status === 200 && r.body.status === "denied", r.body);
  r = await http("POST", `/web/pair/${s2.body.user_code}`, { token: userToken, json: { approve: true } });
  expect("approving a denied code -> 409", r.status === 409 && code(r) === "conflict", r.body);

  const s3 = await http("POST", "/pair/start", { json: { device_name: "E2E expired" } });
  if (s3.body?.pair_id) pairIds.push(s3.body.pair_id);
  await admin.from("ext_pairings").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", s3.body.pair_id);
  r = await http("GET", `/web/pair/${s3.body.user_code}`, { token: userToken });
  expect("expired code: website 404", r.status === 404 && code(r) === "not_found", r.body);
  r = await http("POST", "/pair/poll", { json: { pair_id: s3.body.pair_id, poll_secret: s3.body.poll_secret } });
  expect("expired code: poll -> expired", r.status === 200 && r.body.status === "expired", r.body);
  r = await http("GET", "/web/pair/ZZZZ-ZZZZ", { token: userToken });
  expect("unknown code -> 404", r.status === 404, r.body);

  // -------------------------------------------------------------------------
  section("3. Tokens and devices");
  r = await http("GET", "/me", { token: access });
  expect("/me with the device token", r.status === 200 && r.body.device.id === dev1 && r.body.user.email === email && Array.isArray(r.body.setup_gaps), r.body);
  expect("/me: LinkedIn status", r.body?.linkedin?.cap?.cap === 35 && r.body.linkedin.queue.ready === 0 && r.body.linkedin.enabled === true && r.body.versions.latest === VERSION, r.body?.linkedin);
  const mcpToken = await new SignJWT({ gid: crypto.randomUUID(), scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(BASE)
    .setAudience(`${BASE}/mcp`)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : "dev-jwt-secret-replace-in-production-!!!!"));
  r = await http("GET", "/me", { token: mcpToken });
  expect("an MCP access token is rejected", r.status === 401 && code(r) === "unauthorized", r.body);
  r = await http("GET", "/me", { token: userToken });
  expect("a Supabase session token is rejected", r.status === 401 && code(r) === "unauthorized", r.body);
  r = await http("PATCH", "/device", { token: access, json: { name: "E2E renamed" } });
  expect("rename the device", r.status === 200 && r.body.name === "E2E renamed", r.body);
  r = await http("POST", "/events", { token: access, json: { events: [{ level: "info", type: "e2e.ping", data: { n: 1 } }] } });
  expect("client events upload", r.status === 200 && r.body.ok === true, r.body);
  r = await http("POST", "/events", { token: access, json: { events: [{ level: "info", type: "Bad Type" }] } });
  expect("client events validate", r.status === 400, r.body);

  r = await http("POST", "/token/refresh", { json: { refresh_token: refresh } });
  expect("refresh rotates", r.status === 200 && r.body.refresh_token !== refresh && r.body.access_token, r.body?.error);
  const oldRefresh = refresh;
  access = r.body?.access_token;
  refresh = r.body?.refresh_token;
  r = await http("GET", "/me", { token: access });
  expect("the new access token works", r.status === 200, r.body);
  r = await http("POST", "/token/refresh", { json: { refresh_token: oldRefresh } });
  expect("the old refresh token within 2 minutes -> 409", r.status === 409 && code(r) === "conflict", r.body);
  r = await http("GET", "/me", { token: access });
  expect("...and the device still works", r.status === 200, r.body);
  await admin.from("ext_devices").update({ rotated_at: new Date(Date.now() - 3 * 60_000).toISOString() }).eq("id", dev1);
  r = await http("POST", "/token/refresh", { json: { refresh_token: oldRefresh } });
  expect("the old refresh token after the grace revokes the device", r.status === 401 && code(r) === "device_revoked", r.body);
  r = await http("GET", "/me", { token: access });
  expect("a revoked device -> 401 device_revoked", r.status === 401 && code(r) === "device_revoked", r.body);
  r = await http("POST", "/token/refresh", { json: { refresh_token: refresh } });
  expect("the revoked device's newest refresh token is dead too", r.status === 401, r.body);
  r = await http("POST", "/token/refresh", { json: { refresh_token: "aext_" + "x".repeat(43) } });
  expect("an unknown refresh token -> 401 unauthorized", r.status === 401 && code(r) === "unauthorized", r.body);

  const d2 = await pairDevice(userToken, "E2E web revoke");
  expect("pair a second device", d2.deviceId && d2.access, d2.poll.body);
  r = await http("GET", "/web/devices", { token: userToken });
  expect("web: devices listed (revoked ones hidden)", r.status === 200 && r.body.some((d) => d.id === d2.deviceId) && !r.body.some((d) => d.id === dev1), r.body);
  r = await http("DELETE", `/web/devices/${d2.deviceId}`, { token: userToken });
  expect("web: revoke", r.status === 204, r.body);
  r = await http("GET", "/me", { token: d2.access });
  expect("web revoke is immediate", r.status === 401 && code(r) === "device_revoked", r.body);
  r = await http("DELETE", `/web/devices/${d2.deviceId}`, { token: userToken });
  expect("web: revoking twice -> 404", r.status === 404, r.body);

  const d3 = await pairDevice(userToken, "E2E signout");
  r = await http("POST", "/device/signout", { token: d3.access });
  expect("device sign out", r.status === 200 && r.body.ok === true, r.body);
  r = await http("GET", "/me", { token: d3.access });
  expect("signed-out device -> 401 device_revoked", r.status === 401 && code(r) === "device_revoked", r.body);
  r = await http("GET", "/web/extension", { token: userToken });
  expect("web: extension info", r.status === 200 && r.body.latest_version === VERSION && r.body.download_url === "/downloads/aupply-chrome.zip", r.body);

  // -------------------------------------------------------------------------
  section("4. Setup");
  const dev = await pairDevice(userToken, "E2E main");
  expect("pair the main device", dev.deviceId && dev.access, dev.poll.body);
  r = await http("GET", "/me", { token: dev.access });
  expect("a fresh user has setup gaps", r.status === 200 && r.body.setup_gaps.includes("profile.phone") && r.body.setup_gaps.includes("preferences.expected_salary"), r.body?.setup_gaps);
  r = await http("POST", "/onboarding/propose", { token: dev.access, json: {} });
  expect("propose without a resume -> 404 with a hint", r.status === 404 && /resume/i.test(r.body?.error?.message ?? ""), r.body);
  await admin.from("resumes").insert({
    user_id: userId, label: "E2E resume", is_default: true,
    content: "Asha Testwala\nSoftware Engineer\nasha.testwala@example.com | +91 90000 00000\nPune, India\n\nExperience\nExamplesoft, Software Engineer, 2023 - present\nBuilt APIs in Node.js and TypeScript on PostgreSQL; React dashboards; Docker on AWS.\n\nEducation\nExample Institute of Technology, B.Tech Computer Science, 2019 - 2023",
  });
  r = await http("POST", "/onboarding/propose", { token: dev.access, json: {} });
  expect(
    "propose from the resume (fake AI): email and phone by regex, the rest proposed, nothing saved",
    r.status === 200 && r.body.ai_used === true && r.body.proposal.profile.email === "asha.testwala@example.com" && r.body.proposal.profile.phone === "+91 90000 00000" &&
      r.body.proposal.profile.full_name === "Asha Testwala" && r.body.proposal.profile.skills?.includes("Node.js") && r.body.to_ask.includes("profile.notice_period_days"),
    r.body
  );
  const { data: usage } = await admin.from("ext_ai_usage").select("purpose, model, requests").eq("user_id", userId);
  expect("AI usage is recorded per purpose and model", usage?.some((u) => u.purpose === "onboarding" && u.model === "fake" && u.requests === 1), usage);
  await admin.from("ext_ai_usage").insert({ user_id: userId, day: new Date().toISOString().slice(0, 10), purpose: "fit", model: "e2e-budget", cost_micro_usd: 10_000_000 });
  r = await http("POST", "/onboarding/propose", { token: dev.access, json: {} });
  expect("over the daily AI budget: the proposal falls back to what the regex found", r.status === 200 && r.body.ai_used === false && r.body.proposal.profile.email === "asha.testwala@example.com" && !r.body.proposal.profile.full_name, r.body);
  await admin.from("ext_ai_usage").delete().eq("user_id", userId).eq("model", "e2e-budget");
  r = await http("GET", "/health", { version: null });
  expect("the server's engine self-check passes", r.body?.engine?.ok === true, r.body);

  r = await http("POST", "/session/start", { token: dev.access, json: { mode: "draft_apply" } });
  expect("session/start with gaps -> setup_needed", r.status === 200 && r.body.type === "setup_needed" && r.body.gaps.includes("profile.phone"), r.body);
  r = await http("POST", "/onboarding/save", { token: dev.access, json: { profile: { years_experience: "lots" } } });
  expect("onboarding/save validates with the profile schema", r.status === 400 && code(r) === "invalid_request", r.body);
  r = await http("POST", "/onboarding/save", {
    token: dev.access,
    json: {
      profile: {
        full_name: "Asha Testwala", email: "asha.testwala@example.com", phone: "+91 90000 00000",
        location_city: "Pune", location_country: "India", years_experience: 2, current_title: "Software Engineer",
        current_company: "Examplesoft", skills: ["TypeScript", "Node.js", "React", "PostgreSQL", "Python"],
        notice_period_days: 30, current_salary: 800000, current_salary_currency: "INR", current_salary_period: "year",
      },
      preferences: { desired_roles: ["Backend Engineer", "Full Stack Developer"], expected_salary: 1200000, salary_currency: "INR", salary_period: "year", max_years_required: 3 },
      experiences: [{ company: "Examplesoft", title: "Software Engineer", start_date: "2023-07-01", is_current: true }],
      educations: [{ institution: "Example Institute of Technology", degree: "B.Tech", field_of_study: "Computer Science", start_date: "2019-08-01", end_date: "2023-05-01" }],
    },
  });
  expect("onboarding/save with a full profile clears the gaps", r.status === 200 && r.body.missing.length === 0 && r.body.saved.includes("profile.phone"), r.body);
  r = await http("GET", "/me", { token: dev.access });
  expect("/me: no setup gaps now", r.status === 200 && r.body.setup_gaps.length === 0 && r.body.user.full_name === "Asha Testwala", r.body?.setup_gaps);

  await sessionsSection(userToken, dev);
  await draftSection(dev);
}

// ---------------------------------------------------------------------------
// 5. Sessions
// ---------------------------------------------------------------------------
async function setGuestBlock(minutes) {
  await admin.from("platform_state").upsert(
    { user_id: userId, platform: "linkedin_guest", blocked_until: new Date(Date.now() + minutes * 60_000).toISOString(), block_reason: "e2e" },
    { onConflict: "user_id,platform" }
  );
}
async function clearBlocks() {
  await admin.from("platform_state").update({ blocked_until: null, block_reason: null }).eq("user_id", userId).in("platform", ["linkedin", "linkedin_guest"]);
}
async function setRunMeta(runId, patch) {
  const { data } = await admin.from("runs").select("metadata").eq("id", runId).single();
  await admin.from("runs").update({ metadata: { ...data.metadata, ...patch } }).eq("id", runId);
}

async function sessionsSection(userToken, dev) {
  section("5. Sessions");
  // Preferences the draft fixtures rely on: PHP excluded by name, a pay floor.
  let r = await http("POST", "/onboarding/save", { token: dev.access, json: { preferences: { exclude_keywords: ["PHP"], min_salary: 600000, salary_period: "year" } } });
  expect("preferences for the draft (PHP excluded, pay floor)", r.status === 200, r.body);

  r = await http("POST", "/session/start", { token: dev.access, json: { mode: "draft_apply", posted_within: "1h" } });
  const run1 = r.body?.run_id;
  expect(
    "session/start: started, draft planned (empty queue), a tracker read first",
    r.status === 200 && r.body.type === "started" && r.body.plan.draft === true && r.body.plan.apply === true && r.body.posted_within === "1h" &&
      r.body.first?.type === "tracker" && r.body.first.url === "https://www.linkedin.com/jobs-tracker/?stage=applied" && r.body.cap.cap === 35,
    r.body
  );
  const { data: runRow } = await admin.from("runs").select("client, metadata").eq("id", run1).single();
  expect("the run is a runs row with client aupply_extension", runRow?.client === "aupply_extension" && runRow.metadata.device_id === dev.deviceId, runRow);

  const dev2 = await pairDevice(userToken, "E2E second");
  r = await http("POST", "/session/start", { token: dev2.access, json: { mode: "apply" } });
  expect("a second device while one is live -> busy other_device", r.body?.type === "busy" && r.body.reason === "other_device" && r.body.device_name === "E2E main", r.body);
  r = await http("POST", "/session/heartbeat", { token: dev.access, json: { run_id: run1, phase: "tracker", hidden: true } });
  expect("heartbeat", r.status === 200 && r.body.ok === true && !r.body.stop, r.body);
  r = await http("POST", "/session/heartbeat", { token: dev2.access, json: { run_id: run1, phase: "tracker" } });
  expect("another device's heartbeat for this run -> stop", r.body?.stop?.reason === "run_not_found", r.body);

  await setRunMeta(run1, { last_heartbeat_at: new Date(Date.now() - 31 * 60_000).toISOString() });
  r = await http("POST", "/session/start", { token: dev2.access, json: { mode: "apply" } });
  const run2 = r.body?.run_id;
  expect("a run with no heartbeat for 30 minutes is cleaned up: the second device starts", r.body?.type === "started", r.body);
  r = await http("POST", "/session/heartbeat", { token: dev.access, json: { run_id: run1, phase: "applying" } });
  expect("...and the stale run's device is told to stop", r.body?.stop?.reason === "no heartbeat", r.body);
  const { count: openLeases } = await admin.from("ext_leases").select("id", { count: "exact", head: true }).eq("run_id", run1).is("completed_at", null);
  expect("the stale run's leases were closed", openLeases === 0, openLeases);
  r = await http("POST", "/session/end", { token: dev2.access, json: { run_id: run2, reason: "user_stop" } });
  expect("session/end", r.status === 200 && typeof r.body.counts === "object" && Array.isArray(r.body.saved_for_you), r.body);
  r = await http("POST", "/session/heartbeat", { token: dev2.access, json: { run_id: run2, phase: "done" } });
  expect("an ended run's heartbeat -> stop", r.body?.stop?.reason === "user_stop", r.body);

  await admin.from("platform_state").upsert({ user_id: userId, platform: "engine_linkedin", state: { e2e: true } }, { onConflict: "user_id,platform" });
  r = await http("POST", "/session/start", { token: dev.access, json: { mode: "apply" } });
  expect("Claude working LinkedIn through the MCP -> busy claude_active", r.body?.type === "busy" && r.body.reason === "claude_active" && Date.parse(r.body.retry_at) > Date.now() + 20 * 60_000, r.body);
  await admin.from("platform_state").delete().eq("user_id", userId).eq("platform", "engine_linkedin");

  await setGuestBlock(30);
  r = await http("POST", "/session/start", { token: dev.access, json: { mode: "draft" } });
  expect("a linkedin_guest backoff -> blocked for a draft", r.body?.type === "blocked" && r.body.scope === "linkedin_guest", r.body);
  r = await http("POST", "/session/start", { token: dev.access, json: { mode: "draft_apply" } });
  expect("...while draft_apply starts with the draft left out", r.body?.type === "started" && r.body.plan.draft === false && r.body.plan.apply === true, r.body);
  if (r.body?.run_id) await http("POST", "/session/end", { token: dev.access, json: { run_id: r.body.run_id, reason: "done" } });
  await clearBlocks();
  await http("DELETE", `/web/devices/${dev2.deviceId}`, { token: userToken });
}

// ---------------------------------------------------------------------------
// 6. Draft with synthetic guest pages (invented companies and titles, the markup the parser reads)
// ---------------------------------------------------------------------------
const testJobIds = [];
const card = (id, title, company, loc = "Pune, Maharashtra, India") =>
  `<li>\n<div class="base-card relative" data-entity-urn="urn:li:jobPosting:${id}">\n<h3 class="base-search-card__title">\n  ${title}\n</h3>\n` +
  `<h4 class="base-search-card__subtitle">\n<a class="hidden-nested-link" href="https://www.linkedin.com/company/x">\n${company}\n</a>\n</h4>\n` +
  `<span class="job-search-card__location">\n${loc}\n</span>\n</div>\n</li>`;
const searchPage = (cards) => `<!DOCTYPE html>${cards.join("\n")}`;
const jdPage = (text, { level, ats } = {}) =>
  `<section class="description"><div class="show-more-less-html__markup">${text}</div>` +
  (level ? `<ul class="description__job-criteria-list"><li><h3 class="description__job-criteria-subheader">Seniority level</h3><span>${level}</span></li></ul>` : "") +
  (ats ? `<a href="https://jobs.example.com/apply?applicantTrackingSystemName=${ats}&amp;src=li">Apply</a>` : "") +
  `</section>`;

async function draftSection(dev) {
  section("6. Draft");
  const B = 400_000_000_000 + Math.floor(Math.random() * 1e8) * 100;
  const id = (n) => String(B + n);
  const J = {
    T_SENIOR: id(1), T_STACK: id(2), T_SPAM: id(3), T_OFF: id(4), T_YEARS: id(5), KNOWN: id(6), CACHED: id(7),
    CLOSED: id(10), ATS: id(11), YEARS: id(12), MIDSENIOR: id(13), PAY: id(14), STACK: id(15), FAR: id(16), KEEP: id(17), LOWFIT: id(18), RL: id(19), RL2: id(20),
  };
  testJobIds.push(...Object.values(J));
  const s0p0 = [
    card(J.T_SENIOR, "Senior Backend Engineer", "Acme Widgets"), card(J.T_STACK, "PHP Backend Developer", "Brightcode"),
    card(J.T_SPAM, "Backend Engineer", "DataAnnotation"), card(J.KNOWN, "Backend Engineer", "Echo Labs"),
    card(J.CACHED, "Backend Engineer", "Foxtrot Systems"), card(J.CLOSED, "Backend Engineer", "Gamma Soft"),
    card(J.ATS, "Backend Engineer", "Helix Works"), card(J.YEARS, "Backend Developer", "Indigo Apps"),
    card(J.MIDSENIOR, "Software Engineer", "Juniper Labs"), card(J.PAY, "Backend Engineer", "Kilo Tech"),
  ];
  const s1p0 = [
    card(J.T_OFF, "Sales Executive", "Corvid Retail"), card(J.STACK, "Backend Developer", "Lima Software"),
    card(J.FAR, "Full Stack Developer", "Mango Cloud"), card(J.KEEP, "Backend Engineer", "November Works"),
    card(J.LOWFIT, "Full Stack Developer", "Oscar Data"), card(J.RL, "Backend Engineer", "Papa Systems"),
    card(J.CLOSED, "Backend Engineer", "Gamma Soft"),
  ];
  const s0p1 = [card(J.T_YEARS, "Backend Developer 6+ years", "Delta Apps"), card(J.RL2, "Backend Engineer", "Quebec Labs")];
  const goodJd = jdPage("You will build APIs. 2 years of experience with Node.js, TypeScript and PostgreSQL. Hybrid in Pune.");
  const JD = {
    [J.CLOSED]: jdPage("No longer accepting applications. Node.js work."),
    [J.ATS]: jdPage("Node.js and TypeScript services.", { ats: "Greenhouse" }),
    [J.YEARS]: jdPage("We need 5+ years of experience in Python and Node.js."),
    [J.MIDSENIOR]: jdPage("Python services for payments.", { level: "Mid-Senior level" }),
    [J.PAY]: jdPage("Compensation: Rs 3 - 4 LPA. Python and Node.js."),
    [J.STACK]: jdPage("Our backend is PHP and Node.js."),
    [J.FAR]: jdPage("Our services use Java and Node.js with SQL."),
    [J.KEEP]: goodJd,
    [J.LOWFIT]: jdPage("Event pipelines on Kafka, Kubernetes and Redis."),
    [J.RL]: goodJd,
    [J.RL2]: goodJd,
  };

  // Already known to Aupply, and already read by another user's draft (the shared cache).
  await admin.from("applications").insert({ user_id: userId, platform: "linkedin", external_id: J.KNOWN, company_name: "Echo Labs", job_title: "Backend Engineer", status: "applied", applied_by: "user" });
  await admin.from("job_postings").insert({
    platform: "linkedin", external_id: J.CACHED, title: "Backend Engineer", company: "Foxtrot Systems",
    jd_text: "We use Node.js, TypeScript and PostgreSQL. 1 year of experience is enough.", jd_fetched_at: new Date().toISOString(),
  });

  let r = await http("POST", "/session/start", { token: dev.access, json: { mode: "draft", posted_within: "1h" } });
  const runId = r.body?.run_id;
  const tracker = r.body?.first;
  expect("session/start for a draft", r.body?.type === "started" && r.body.plan.draft === true && r.body.plan.apply === false, r.body);
  r = await http("POST", "/linkedin/draft/start", { token: dev.access, json: { run_id: runId } });
  const draftId = r.body?.draft_id;
  expect(
    "draft/start while the tracker lease is open -> started, first order waits (lease_busy)",
    r.body?.type === "started" && draftId && r.body.order.type === "wait" && r.body.order.reason === "lease_busy" &&
      r.body.searching.posted_within === "1h" && r.body.searching.roles.join() === "Backend Engineer,Full Stack Developer" && r.body.searching.windows.join() === "1h",
    r.body
  );
  r = await http("POST", "/linkedin/tracker", { token: dev.access, json: { lease_id: tracker.lease_id, count: 7 } });
  expect("tracker read recorded", r.status === 200 && r.body.cap.cap === 35, r.body);
  const { data: lst } = await admin.from("platform_state").select("state").eq("user_id", userId).eq("platform", "linkedin").single();
  expect("the tracker count is stored the way the MCP stores it", lst?.state?.tracker?.first === 7 && lst.state.tracker.last === 7, lst?.state);

  const next = (body) => http("POST", "/linkedin/draft/next", { token: dev.access, json: { draft_id: draftId, ...body } });
  r = await next({});
  let order = r.body;
  const u0 = order?.pages?.[0] ? new URL(order.pages[0].url) : null;
  expect(
    "first search order: one page of each search, the guest search URL as li_sweep builds it",
    order?.type === "search" && order.gap_ms >= 1000 && order.pages.length === 2 && order.pages[0].s === 0 && order.pages[1].s === 1 &&
      u0?.origin + u0?.pathname === "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" && u0.searchParams.get("keywords") === "Backend Engineer" &&
      u0.searchParams.get("f_TPR") === "r3600" && u0.searchParams.get("f_AL") === "true" && u0.searchParams.get("sortBy") === "DD" && u0.searchParams.get("start") === "0" &&
      u0.searchParams.get("location") === "India" && u0.searchParams.get("geoId") === "102713980",
    order
  );
  r = await next({ lease_id: order.lease_id, result: { pages: [{ url: order.pages[0].url, status: 200, html: searchPage(s0p0) }, { url: order.pages[1].url, status: 200, html: searchPage(s1p0) }] } });
  const order2 = r.body;
  expect("a search with fewer than 10 cards stops paging; the full one asks for page 2", order2?.type === "search" && order2.pages.length === 1 && order2.pages[0].s === 0 && order2.pages[0].page === 1 && new URL(order2.pages[0].url).searchParams.get("start") === "10", order2);
  const { data: firstLease } = await admin.from("ext_leases").select("completed_at").eq("id", order.lease_id).single();
  expect("orders are paced: not_before at least 2s after the last one finished", Date.parse(order2.not_before) - Date.parse(firstLease.completed_at) >= 1900, { nb: order2.not_before, done: firstLease.completed_at });
  r = await next({ lease_id: order.lease_id, result: { pages: [] } });
  expect("posting a result for a completed lease again is idempotent (same next order)", r.body?.lease_id === order2.lease_id, r.body);

  r = await next({ lease_id: order2.lease_id, result: { pages: [{ url: order2.pages[0].url, status: 200, html: searchPage(s0p1) }] } });
  let jd1 = r.body;
  const jd1ids = jd1?.jobs?.map((j) => j.id) ?? [];
  expect(
    "first JD order: 10 jobs, none title-dropped, known or cached, guest JD URLs",
    jd1?.type === "jd" && jd1.gap_ms >= 1500 && jd1ids.length === 10 && ![J.T_SENIOR, J.T_STACK, J.T_SPAM, J.T_OFF, J.T_YEARS, J.KNOWN, J.CACHED].some((x) => jd1ids.includes(x)) &&
      jd1.jobs.every((j) => j.url === `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${j.id}`),
    jd1
  );
  // Answer in order; the rate-limited job gets a 429 and the batch stops there (the content script's rule).
  const answer = (o, limited) => {
    const jobs = [];
    for (const j of o.jobs) {
      if (limited.has(j.id)) { jobs.push({ id: j.id, status: 429, html: "" }); break; }
      jobs.push({ id: j.id, status: 200, html: JD[j.id] });
    }
    return { jobs, ...(jobs.some((j) => j.status === 429) ? { stopped: "rate_limited" } : {}) };
  };
  r = await next({ lease_id: jd1.lease_id, result: answer(jd1, new Set([J.RL])) });
  expect("a 429 in a JD batch -> wait (rate_limited)", r.body?.type === "wait" && r.body.reason === "rate_limited", r.body);
  const { data: gb } = await admin.from("platform_state").select("blocked_until").eq("user_id", userId).eq("platform", "linkedin_guest").single();
  const left1 = Date.parse(gb?.blocked_until) - Date.now();
  expect("...with a 10 minute linkedin_guest backoff", left1 > 8 * 60_000 && left1 <= 10 * 60_000, gb);
  r = await next({ lease_id: jd1.lease_id, result: answer(jd1, new Set()) });
  expect("asking again during the backoff still waits", r.body?.type === "wait" && r.body.reason === "rate_limited", r.body);
  await clearBlocks();
  r = await next({ lease_id: jd1.lease_id });
  const jd2 = r.body;
  expect("after the pause the rate-limited job is read first", jd2?.type === "jd" && jd2.jobs[0]?.id === J.RL && jd2.jobs.some((j) => j.id === J.RL2), jd2);
  r = await next({ lease_id: jd2.lease_id, result: answer(jd2, new Set([J.RL2])) });
  const done = r.body;
  const s = done?.summary ?? {};
  expect("a second 429 ends the draft (done, stop rate_limited_jd)", done?.type === "done" && s.stop === "rate_limited_jd", done);
  expect(
    "draft summary counts",
    s.found === 18 && s.already_known === 1 && s.cached === 1 && s.read === 10 && s.kept === 4 && s.decisions === 1 && s.low_fit === 1 &&
      ["title_seniority", "title_stack", "company", "title_off_target", "title_years"].every((k) => s.title_dropped?.[k] === 1) && Object.keys(s.title_dropped).length === 5 &&
      ["CLOSED", "DROP_ATS", "DROP_YEARS", "DROP_MIDSENIOR", "DROP_PAY", "DROP_STACK"].every((c) => s.prescreen_dropped?.[c] === 1),
    s
  );
  const { data: gb2 } = await admin.from("platform_state").select("blocked_until").eq("user_id", userId).eq("platform", "linkedin_guest").single();
  expect("...with a 60 minute linkedin_guest backoff", Date.parse(gb2?.blocked_until) - Date.now() > 50 * 60_000, gb2);
  const { data: dr } = await admin.from("ext_drafts").select("status, stop_reason").eq("id", draftId).single();
  expect("the draft row is stopped", dr?.status === "stopped" && dr.stop_reason === "rate_limited_jd", dr);
  r = await next({ lease_id: jd2.lease_id });
  expect("draft/next after the end answers done again", r.body?.type === "done", r.body);

  const { data: rows } = await admin.from("applications").select("external_id, status, status_reason, match_score, metadata, run_id").eq("user_id", userId).eq("platform", "linkedin").in("external_id", Object.values(J));
  const row = (k) => rows?.find((x) => x.external_id === J[k]);
  expect(
    "prescreen drops stored as skipped 'draft: <CODE>' (as queue_jobs stores them)",
    [["CLOSED", "CLOSED"], ["ATS", "DROP_ATS"], ["YEARS", "DROP_YEARS"], ["MIDSENIOR", "DROP_MIDSENIOR"], ["PAY", "DROP_PAY"], ["STACK", "DROP_STACK"]].every(
      ([k, c]) => row(k)?.status === "skipped" && row(k).status_reason === `draft: ${c}` && row(k).metadata.skip_code === c && row(k).metadata.channel === "extension"
    ),
    rows
  );
  expect("title-filter rejects are not stored", !["T_SENIOR", "T_STACK", "T_SPAM", "T_OFF", "T_YEARS"].some((k) => row(k)), rows?.map((x) => x.external_id));
  expect(
    "kept jobs are discovered with match_score and metadata.ai (cached, read, and the one read after the pause)",
    ["CACHED", "KEEP", "RL"].every((k) => row(k)?.status === "discovered" && row(k).match_score === 90 && row(k).metadata.ai?.verdict === "strong" && row(k).metadata.ai.basis === "resume" && row(k).metadata.w === "1h" && row(k).run_id === runId),
    ["CACHED", "KEEP", "RL"].map(row)
  );
  expect("a far technology: discovered and waiting on the user's decision", row("FAR")?.status === "discovered" && row("FAR").metadata.needs_decision === true && row("FAR").metadata.sm?.join() === "Java", row("FAR"));
  expect("a weak fit is skipped as LOW_FIT", row("LOWFIT")?.status === "skipped" && row("LOWFIT").status_reason === "draft: LOW_FIT 30", row("LOWFIT"));
  expect("the job hit by the second 429 is not stored (found again next time)", !row("RL2"), row("RL2"));
  const { data: posts } = await admin.from("job_postings").select("external_id, first_seen_by, jd_text, ai_facts, facts").in("external_id", [J.KEEP, J.CACHED, J.FAR]);
  const post = (k) => posts?.find((p) => p.external_id === J[k]);
  expect("job_postings: first_seen_by and the JD are stored for a job this user found", post("KEEP")?.first_seen_by === userId && post("KEEP").jd_text?.includes("Node.js") && post("KEEP").ai_facts?.must_have?.length === 3 && post("KEEP").facts?.stack_all?.includes("TypeScript"), post("KEEP"));
  expect("job_postings: a cached row keeps its first_seen_by (null here)", post("CACHED") && post("CACHED").first_seen_by === null, post("CACHED"));

  r = await http("GET", "/linkedin/decisions", { token: dev.access });
  expect("decisions list the far-technology job", r.status === 200 && r.body.items.length === 1 && r.body.items[0].job_id === J.FAR && r.body.items[0].wants.join() === "Java", r.body);
  const farId = r.body?.items?.[0]?.id;
  r = await http("GET", "/linkedin/queue?posted_within=1h", { token: dev.access });
  expect("the queue holds the three ready jobs, best first, with reasons", r.status === 200 && r.body.items.length === 3 && r.body.items.every((i) => i.score === 90 && i.reasons.length && i.window === "1h"), r.body);
  r = await http("POST", "/linkedin/decisions", { token: dev.access, json: { items: [{ id: farId, keep: true }] } });
  expect("keep a far-technology job", r.status === 200 && r.body.kept === 1, r.body);
  r = await http("GET", "/linkedin/queue?posted_within=1h", { token: dev.access });
  const rlItem = r.body?.items?.find((i) => i.job_id === J.RL);
  expect("...it joins the queue", r.body?.items?.length === 4 && r.body.items.some((i) => i.job_id === J.FAR), r.body);
  r = await http("POST", `/linkedin/queue/${rlItem?.id}/skip`, { token: dev.access });
  expect("remove a job from the queue", r.status === 200 && r.body.ok === true, r.body);
  r = await http("GET", "/linkedin/queue?posted_within=1h", { token: dev.access });
  expect("...it is gone", r.body?.items?.length === 3 && !r.body.items.some((i) => i.job_id === J.RL), r.body);
  r = await http("GET", "/me", { token: dev.access });
  expect("/me: queue numbers", r.body?.linkedin?.queue?.ready >= 0 && r.body.linkedin.queue.decisions === 0 && r.body.linkedin.blocked?.scope === "linkedin_guest", r.body?.linkedin);
  r = await http("POST", "/session/end", { token: dev.access, json: { run_id: runId, reason: "done" } });
  expect("session/end counts the run's jobs", r.status === 200 && r.body.counts.discovered === 3 && r.body.counts.skipped >= 7, r.body);
  await clearBlocks();
  expect("no response body ever carried the user id (first_seen_by never leaves the server)", !seenBodies.some((b) => b.includes(userId)), null);
}

async function cleanup() {
  section("Cleanup");
  try {
    if (pairIds.length) await admin.from("ext_pairings").delete().in("id", pairIds);
    if (testJobIds.length) await admin.from("job_postings").delete().eq("platform", "linkedin").in("external_id", testJobIds);
    if (userId) {
      const del = await admin.auth.admin.deleteUser(userId);
      expect("delete the throwaway user (no ext_ table blocks the cascade)", !del.error, del.error?.message);
      const { count } = await admin.from("ext_devices").select("id", { count: "exact", head: true }).eq("user_id", userId);
      expect("its devices went with it", count === 0, count);
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
