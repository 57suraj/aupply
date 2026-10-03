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
/** The extension stamps its writes to applications (metadata.ext_at); test housekeeping that
    stands in for the extension does too, or it would look like Claude working through the MCP. */
const extAt = () => ({ ext_at: new Date().toISOString() });
async function touchApp(id, patch = {}) {
  const { data } = await admin.from("applications").select("metadata").eq("id", id).single();
  await admin.from("applications").update({ ...patch, metadata: { ...(data?.metadata ?? {}), ...(patch.metadata ?? {}), ...extAt() } }).eq("id", id);
}

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
  await applySection(dev);
  await liveFixesSection(dev);
  await killSwitchSection(dev);
  section("Privacy");
  expect("no response body ever carried the user id", !seenBodies.some((b) => b.includes(userId)), null);
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
  const { data: mcpRow } = await admin
    .from("applications")
    .insert({ user_id: userId, platform: "linkedin", external_id: "399999999901", company_name: "Mcp Corp", job_title: "Backend Engineer", status: "applied", metadata: { engine: "linkedin@abc" } })
    .select("id")
    .single();
  r = await http("POST", "/session/start", { token: dev.access, json: { mode: "apply" } });
  expect("a LinkedIn application written by something other than the extension (the MCP's report_results) -> claude_active", r.body?.type === "busy" && r.body.reason === "claude_active", r.body);
  await admin.from("applications").delete().eq("id", mcpRow?.id);

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
  // The day's AI budget is spent before the last job is scored: it gets the deterministic score.
  await admin.from("ext_ai_usage").insert({ user_id: userId, day: new Date().toISOString().slice(0, 10), purpose: "fit", model: "e2e-budget", cost_micro_usd: 10_000_000 });
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
  await admin.from("ext_ai_usage").delete().eq("user_id", userId).eq("model", "e2e-budget");
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
    "kept jobs are discovered with match_score and metadata.ai (from the cache, and read)",
    ["CACHED", "KEEP"].every((k) => row(k)?.status === "discovered" && row(k).match_score === 90 && row(k).metadata.ai?.verdict === "strong" && row(k).metadata.ai.basis === "resume" && row(k).metadata.w === "1h" && row(k).run_id === runId),
    ["CACHED", "KEEP"].map(row)
  );
  expect(
    "with the AI budget spent, a job gets the deterministic score (queue_jobs' arithmetic: 50, +30 last hour, +10 years fit)",
    row("RL")?.status === "discovered" && row("RL").match_score === 90 && row("RL").metadata.ai?.basis === "fallback" && row("RL").metadata.ai.model === null,
    row("RL")
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
  expect(
    "the queue holds the three ready jobs, best first, with the AI's reasons",
    r.status === 200 && r.body.items.length === 3 && r.body.items.every((i) => i.score === 90 && i.window === "1h") && r.body.items.filter((i) => i.reasons.length).length === 2,
    r.body
  );
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

// ---------------------------------------------------------------------------
// Fixes from the first live test (docs/extension/BUGS.md B1 to B3)
// ---------------------------------------------------------------------------
async function liveFixesSection(dev) {
  section("Live-test fixes (BUGS.md B1 to B3)");
  // Room under today's cap again, no backoffs.
  await admin.from("applications").delete().eq("user_id", userId).eq("company_name", "Cap Filler");
  await clearBlocks();
  const B = 700_000_000_000 + Math.floor(Math.random() * 1e8) * 100;
  const ids = { P1: String(B + 1), P2: String(B + 2), P3: String(B + 3) };
  testJobIds.push(...Object.values(ids));
  await admin.from("applications").insert(
    Object.entries(ids).map(([k, ext], i) => ({
      user_id: userId, platform: "linkedin", external_id: ext, job_url: `https://www.linkedin.com/jobs/view/${ext}/`, company_name: `Fixco ${k}`,
      job_title: "Backend Engineer", status: "discovered", match_score: 99 - i, source: "sweep", experience_min_years: 1,
      metadata: { w: "1h", agg: 0, lvl: null, pay: null, sm: [], yu: 0, needs_decision: false, channel: "extension", ...extAt() },
    }))
  );
  let r = await http("POST", "/session/start", { token: dev.access, json: { mode: "apply", posted_within: "1h" } });
  const runId = r.body?.run_id;
  expect("a run for the fixes", r.body?.type === "started", r.body);
  await http("POST", "/linkedin/tracker", { token: dev.access, json: { lease_id: r.body.first.lease_id, count: 13 } });
  const next = () => http("POST", "/linkedin/apply/next", { token: dev.access, json: { run_id: runId } });
  const answers = (lease, fields, company) => http("POST", "/linkedin/apply/answers", { token: dev.access, json: { lease_id: lease, page: { progress: "50%", index: 0 }, company, fields } });
  const result = (lease, res) => http("POST", "/linkedin/apply/result", { token: dev.access, json: { lease_id: lease, result: res } });
  const yn = (fid, label) => ({ fid, kind: "radio", label, options: ["Yes", "No"], required: true });
  const PY = "Have you personally built Python scripts or backend services that process files, automate workflows, or integrate APIs, beyond coursework or guided tutorials?";
  const AWS = "Have you personally configured or troubleshot AWS S3 uploads, cloud storage permissions, or applications running on Linux servers?";
  const JAVA = "Have you personally built production services in Java?";
  const PROJ = "Is your current project in production?";
  // Wordings the resolver does not answer (its catch-all answers "...okay with a 2 year bond?" as a
  // technology question: BUGS.md B5).
  const BOND = "Are you okay to sign a 2 year service bond?";
  const BOND2 = "Are you ready to sign a 2 year service bond?";
  const LATEST = "Is your latest project open source?";

  r = await next();
  const L1 = r.body;
  r = await answers(L1.lease_id, [yn("a", PY), yn("b", AWS), yn("c", JAVA), yn("d", PROJ), yn("e", BOND)], "Fixco P1");
  const act = Object.fromEntries((r.body?.actions ?? []).map((a) => [a.fid, a]));
  expect("B1: the two skill questions from the live test are answered Yes by the rule, never asked", act.a?.do === "choose" && act.a.index === 0 && act.b?.do === "choose" && act.b.index === 0, r.body);
  expect("B1: a far technology (Java for this user) stays No", act.c?.do === "choose" && act.c.index === 1, act.c);
  expect("B1: a personal question (a service bond) and an unknown one still go to the user", r.body?.verdict === "needs_input" && r.body.questions?.length === 2, r.body);
  const { data: lease1 } = await admin.from("ext_leases").select("detail").eq("id", L1.lease_id).single();
  const qa1 = lease1?.detail?.pages?.["0"]?.qa ?? [];
  expect("B1: logged as rule:qualify", qa1.filter((x) => x.source === "rule:qualify").length === 2, qa1);
  const projQ = r.body?.questions?.find((q) => q.question === PROJ);
  const bondQ = r.body?.questions?.find((q) => q.question === BOND);
  const { data: projRow } = await admin.from("ext_questions").select("key").eq("id", projQ?.id).single();
  expect("B2: a question the resolver files under a key it never reads back (projects_text) is kept keyless", projRow && projRow.key === null, projRow);
  await result(L1.lease_id, { r: "NEEDS_INPUT", question_ids: r.body.questions.map((q) => q.id) });

  r = await next();
  const L2 = r.body;
  r = await answers(L2.lease_id, [yn("f", LATEST), yn("g", BOND2)], "Fixco P2");
  const latestQ = r.body?.questions?.find((q) => q.question === LATEST);
  const bond2Q = r.body?.questions?.find((q) => q.question === BOND2);
  expect("B3: a rephrased open question joins it (one question for the user)", L2?.job?.id === ids.P2 && bond2Q?.id === bondQ?.id && latestQ && latestQ.id !== projQ?.id, r.body);
  await result(L2.lease_id, { r: "NEEDS_INPUT", question_ids: r.body.questions.map((q) => q.id) });
  r = await http("GET", "/questions", { token: dev.access });
  expect("B3: the grouped question waits for both jobs", r.body?.items?.find((i) => i.id === bondQ?.id)?.waiting_count === 2, r.body);

  for (const [q, a] of [[projQ, "Yes"], [latestQ, "No"], [bondQ, "Yes"]]) await http("POST", `/questions/${q.id}/answer`, { token: dev.access, json: { answer: a } });
  const { data: rows } = await admin.from("answers").select("id, key, question, answer").eq("user_id", userId).in("question", [PROJ, LATEST, BOND, BOND2]);
  const ans = (q) => rows?.find((x) => x.question === q);
  expect(
    "B2: two questions under one resolver key keep two separate, keyless answers",
    ans(PROJ)?.answer === "Yes" && ans(LATEST)?.answer === "No" && ans(PROJ).id !== ans(LATEST).id && ans(PROJ).key === null && ans(LATEST).key === null,
    rows
  );
  expect("B3: the answer is saved under every wording", ans(BOND)?.answer === "Yes" && ans(BOND2)?.answer === "Yes", rows);

  r = await next();
  const L1b = r.body;
  r = await answers(L1b.lease_id, [yn("a", PY), yn("b", AWS), yn("c", JAVA), yn("d", PROJ), yn("e", BOND)], "Fixco P1");
  expect("B2: once answered, the job's questions are not asked again (the loop of the live test)", L1b?.job?.id === ids.P1 && r.body?.verdict === "fill" && !r.body.questions, r.body);
  await result(L1b.lease_id, { r: "SENT" });
  r = await next();
  const L2b = r.body;
  r = await answers(L2b.lease_id, [yn("f", LATEST), yn("g", BOND2)], "Fixco P2");
  const act2 = Object.fromEntries((r.body?.actions ?? []).map((a) => [a.fid, a]));
  expect("B3: the rephrased question is answered with the user's answer", L2b?.job?.id === ids.P2 && r.body?.verdict === "fill" && act2.f?.index === 1 && act2.g?.index === 0, r.body);
  await result(L2b.lease_id, { r: "SENT" });
  r = await next();
  const L3 = r.body;
  r = await answers(L3.lease_id, [yn("h", "Can you sign a 2 year service bond?")], "Fixco P3");
  expect("B3: a new rephrasing of an answered question is answered, not asked", L3?.job?.id === ids.P3 && r.body?.verdict === "fill" && r.body.actions[0]?.index === 0, r.body);
  await result(L3.lease_id, { r: "SENT" });

  // B4: LinkedIn's number fields get numbers, even from a saved prose answer; a second ask for the
  // same page (the numbers LinkedIn refused) adds to that page's Q&A.
  await admin.from("answers").insert({ user_id: userId, question: "Current CTC", answer: "8 LPA (800000 INR per year)", status: "confirmed", source: "user" });
  const P4 = String(B + 4);
  testJobIds.push(P4);
  const { data: p4 } = await admin
    .from("applications")
    .insert({
      user_id: userId, platform: "linkedin", external_id: P4, job_url: `https://www.linkedin.com/jobs/view/${P4}/`, company_name: "Fixco P4",
      job_title: "Backend Engineer", status: "discovered", match_score: 99, source: "sweep",
      metadata: { w: "1h", agg: 0, sm: [], needs_decision: false, channel: "extension", ...extAt() },
    })
    .select("id")
    .single();
  r = await next();
  const L4 = r.body;
  r = await answers(L4.lease_id, [{ fid: "p", kind: "text", label: "Mobile phone number", required: true }], "Fixco P4");
  r = await answers(L4.lease_id, [{ fid: "n", kind: "number", label: "Current ctc:", required: true }], "Fixco P4");
  expect("B4: a number field with a saved prose answer gets the rule's number", L4?.job?.id === P4 && r.body?.actions?.[0]?.value === "800000", r.body);
  const { data: lease4 } = await admin.from("ext_leases").select("detail").eq("id", L4.lease_id).single();
  expect("B4: the second ask for the page adds to its Q&A", (lease4?.detail?.pages?.["0"]?.qa ?? []).map((x) => x.question).join("|") === "Mobile phone number|Current ctc:", lease4?.detail?.pages);
  await result(L4.lease_id, { r: "SENT" });

  // B4: a job waiting on a question that is no longer open (a release that did not land) is ready.
  const P5 = String(B + 5);
  testJobIds.push(P5);
  await admin.from("applications").insert({
    user_id: userId, platform: "linkedin", external_id: P5, job_url: `https://www.linkedin.com/jobs/view/${P5}/`, company_name: "Fixco P5",
    job_title: "Backend Engineer", status: "discovered", match_score: 99, source: "sweep",
    metadata: { w: "1h", agg: 0, sm: [], needs_decision: false, channel: "extension", needs_input: [projQ.id], ...extAt() },
  });
  r = await http("GET", "/me", { token: dev.access });
  expect("B4: a job waiting only on answered questions is not counted as waiting", r.body?.linkedin?.queue?.waiting_on_you === 0, r.body?.linkedin?.queue);
  r = await next();
  expect("B4: ...and is applied to", r.body?.job?.id === P5, r.body);
  if (r.body?.lease_id) await result(r.body.lease_id, { r: "SENT" });
  void p4;
  await http("POST", "/session/end", { token: dev.access, json: { run_id: runId, reason: "done" } });
}

// ---------------------------------------------------------------------------
// The kill switch: a second local server with EXT_LINKEDIN_ENABLED=false (same issuer, so the
// device token is valid there too). Skipped against a deployed server.
// ---------------------------------------------------------------------------
async function killSwitchSection(dev) {
  section("Kill switch");
  if (!/^http:\/\/localhost:\d+$/.test(BASE)) {
    console.log("  (skipped: needs a local server)");
    return;
  }
  const { spawn } = await import("node:child_process");
  const port = Number(new URL(BASE).port) + 1;
  const child = spawn("npx", ["tsx", "src/extension/server/dev.ts"], {
    env: { ...process.env, MCP_BASE_URL: BASE, EXT_PORT: String(port), EXT_LINKEDIN_ENABLED: "false", AI_FAKE: "1", EXT_MIN_VERSION: "0.1.0" },
    stdio: "ignore",
  });
  const OFF = `http://localhost:${port}/ext/v1`;
  try {
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`${OFF}/health`).then((x) => x.ok).catch(() => false);
      if (ok) break;
      await sleep(500);
    }
    // A draft run (today's cap is full by now, which only refuses applying).
    let r = await http("POST", "/session/start", { token: dev.access, json: { mode: "draft" } });
    const runId = r.body?.run_id;
    expect("(a live run started while the switch is on)", r.body?.type === "started", r.body);
    r = await http("POST", `${OFF}/session/start`, { token: dev.access, json: { mode: "draft_apply" } });
    expect("switched off: session/start -> disabled", r.body?.type === "disabled" && r.body.message.length > 10, r.body);
    r = await http("POST", `${OFF}/linkedin/draft/start`, { token: dev.access, json: { run_id: runId } });
    expect("switched off: draft/start -> disabled", r.body?.type === "disabled", r.body);
    r = await http("POST", `${OFF}/linkedin/apply/next`, { token: dev.access, json: { run_id: runId } });
    expect("switched off: apply/next -> disabled", r.body?.type === "disabled", r.body);
    r = await http("POST", `${OFF}/session/heartbeat`, { token: dev.access, json: { run_id: runId, phase: "applying" } });
    expect("switched off: a live run's heartbeat says stop", r.body?.stop?.reason === "disabled", r.body);
    r = await http("GET", `${OFF}/me`, { token: dev.access });
    expect("switched off: /me says LinkedIn is off", r.body?.linkedin?.enabled === false, r.body?.linkedin);
    await http("POST", "/session/end", { token: dev.access, json: { run_id: runId, reason: "done" } });
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// 7 to 10. Apply: leases and pacing, form answers, results, questions, review, cap, cron
// ---------------------------------------------------------------------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthSel = (fid, index) => ({ fid, kind: "date_select", label: "", options: ["Month", ...MONTHS], option_values_empty: [true, ...MONTHS.map(() => false)], required: false, date: { part: "month", index, context: "education" } });
const yearSel = (fid, index) => {
  const years = ["2018", "2019", "2020", "2021", "2022", "2023", "2024"];
  return { fid, kind: "date_select", label: "", options: ["Year", ...years], option_values_empty: [true, ...years.map(() => false)], required: false, date: { part: "year", index, context: "education" } };
};
const sel = (fid, label, options, required = true) => ({ fid, kind: "select", label, options: ["Select an option", ...options], option_values_empty: [true, ...options.map(() => false)], required });

async function applySection(dev) {
  const B = 500_000_000_000 + Math.floor(Math.random() * 1e8) * 100;
  const jobs = {
    A: ["Backend Engineer", "Rho Tech", 99], B: ["Backend Engineer", "Sigma Labs", 98], C: ["Backend Developer", "Tau Systems", 97],
    D: ["Software Engineer", "Upsilon Apps", 96], E: ["Backend Engineer", "Phi Works", 95], J: ["Backend Engineer", "Alpha Two", 94],
    F: ["Backend Engineer", "Chi Apps", 93], G: ["Backend Engineer", "Psi Cloud", 92], H: ["Backend Engineer", "Omega Soft", 91], K: ["Backend Engineer", "Kappa Data", 90],
    V: ["Backend Engineer", "Vega Labs", 89],
  };
  const ids = Object.fromEntries(Object.keys(jobs).map((k, i) => [k, String(B + i + 1)]));
  testJobIds.push(...Object.values(ids));
  // A clean queue: the draft section's jobs leave it, these ten join it.
  const { data: leftover } = await admin.from("applications").select("id").eq("user_id", userId).eq("status", "discovered");
  for (const row of leftover ?? []) await touchApp(row.id, { status: "skipped", status_reason: "e2e" });
  const { data: inserted } = await admin
    .from("applications")
    .insert(
      Object.entries(jobs).map(([k, [title, company, score]]) => ({
        user_id: userId, platform: "linkedin", external_id: ids[k], job_url: `https://www.linkedin.com/jobs/view/${ids[k]}/`, company_name: company, job_title: title,
        status: "discovered", match_score: score, source: "sweep", experience_min_years: 1,
        metadata: { w: "1h", agg: 0, lvl: null, pay: null, sm: [], yu: 0, needs_decision: false, channel: "extension", ...extAt() },
      }))
    )
    .select("id, external_id");
  const appId = Object.fromEntries(Object.entries(ids).map(([k, ext]) => [k, inserted?.find((r) => r.external_id === ext)?.id]));
  const app = async (k) => (await admin.from("applications").select("status, status_reason, applied_by, metadata").eq("id", appId[k]).single()).data;
  const park = (k) => touchApp(appId[k], { status: "skipped", status_reason: "e2e" });

  section("7. Apply: leases and pacing");
  let r = await http("POST", "/session/start", { token: dev.access, json: { mode: "apply", posted_within: "1h" } });
  const runId = r.body?.run_id;
  expect("session/start for applying", r.body?.type === "started" && r.body.plan.apply === true && r.body.plan.draft === false, r.body);
  r = await http("POST", "/linkedin/tracker", { token: dev.access, json: { lease_id: r.body.first.lease_id, count: 10 } });
  expect("the run's first tracker read", r.status === 200, r.body);
  const next = () => http("POST", "/linkedin/apply/next", { token: dev.access, json: { run_id: runId } });
  const result = (lease, res) => http("POST", "/linkedin/apply/result", { token: dev.access, json: { lease_id: lease, result: res } });
  const answers = (lease, fields, company = "", index = 0) => http("POST", "/linkedin/apply/answers", { token: dev.access, json: { lease_id: lease, page: { progress: "50%", index }, company, fields } });

  r = await next();
  const LA = r.body;
  expect(
    "apply/next: the best queued job, with what the extension needs",
    LA?.type === "job" && LA.job.id === ids.A && LA.job.url === `https://www.linkedin.com/jobs/view/${ids.A}/` && LA.job.company === "Rho Tech" && LA.job.title === "Backend Engineer" &&
      LA.page_wait_ms === 6000 && LA.country === "India" && LA.attempt === 1 && LA.verify === false,
    LA
  );
  r = await next();
  const { count: openCount } = await admin.from("ext_leases").select("id", { count: "exact", head: true }).eq("user_id", userId).is("completed_at", null);
  expect("asking again returns the same open lease, never a second one", r.body?.lease_id === LA.lease_id && openCount === 1, { again: r.body?.lease_id, openCount });
  r = await http("POST", "/linkedin/draft/start", { token: dev.access, json: { run_id: runId } });
  expect("a draft while an apply lease is open waits (one open lease per user)", r.body?.type === "started" && r.body.order.type === "wait" && r.body.order.reason === "lease_busy", r.body);

  section("8. Form answers");
  const pageA = [
    sel("f1", "What is your notice period?", ["Immediate", "15 days", "1 month", "2 months"]),
    { fid: "f2", kind: "number", label: "How many years of work experience do you have?", required: true },
    sel("f3", "How did you hear about us?", ["Referral", "LinkedIn", "Other"]),
    sel("f4", "Gender", ["Male", "Female", "Decline to self-identify"], false),
    { fid: "f5", kind: "checkbox", label: "I agree to the privacy policy", required: true },
    { fid: "f6", kind: "checkbox", label: "Send me marketing emails about new jobs", required: false },
    { fid: "f7", kind: "checkbox", label: "Follow Rho Tech to stay up to date with their page", required: false },
    { fid: "f8", kind: "radio", label: "Resume_Asha_Testwala.pdf", options: ["Resume_Asha_Testwala.pdf", "Resume_old.pdf"], required: true },
    monthSel("f9a", 0), yearSel("f9b", 1), monthSel("f9c", 2), yearSel("f9d", 3),
    { fid: "f10", kind: "typeahead", label: "City", required: true },
    { fid: "f11", kind: "textarea", label: "Why do you want to join Rho Tech?", required: true, max_length: 1000 },
  ];
  r = await answers(LA.lease_id, pageA, "Rho Tech");
  const act = Object.fromEntries((r.body?.actions ?? []).map((a) => [a.fid, a]));
  expect("a page the rules can fill: verdict fill, AI used for the long-form question", r.body?.verdict === "fill" && r.body.ai_used === true && !r.body.questions, r.body);
  expect("notice period select -> the band that holds 30 days", act.f1?.do === "choose" && act.f1.index === 3, act.f1);
  expect("years number field -> a whole number", act.f2?.do === "set" && act.f2.value === "2", act.f2);
  expect("how did you hear -> LinkedIn", act.f3?.do === "choose" && act.f3.index === 2, act.f3);
  expect("EEO select -> decline", act.f4?.do === "choose" && act.f4.index === 3, act.f4);
  expect("consent box ticked; marketing and Follow never", act.f5?.do === "tick" && act.f6?.do === "leave" && act.f7?.do === "leave", [act.f5, act.f6, act.f7]);
  expect("resume radio -> the first", act.f8?.do === "choose" && act.f8.index === 0, act.f8);
  expect("education date selects -> August 2019 to May 2023", act.f9a?.index === 8 && act.f9b?.index === 2 && act.f9c?.index === 5 && act.f9d?.index === 6, [act.f9a, act.f9b, act.f9c, act.f9d]);
  expect("city typeahead -> the city (the extension picks the suggestion)", act.f10?.do === "set" && act.f10.value === "Pune", act.f10);
  expect("'Why do you want to join?' -> an AI answer", act.f11?.do === "set" && act.f11.value.length > 20, act.f11);
  const { data: aiSaved } = await admin.from("answers").select("id, status, source, metadata").eq("user_id", userId).ilike("question", "Why do you want to join Rho Tech?");
  expect("...saved as a provisional answer from the extension's AI", aiSaved?.length === 1 && aiSaved[0].status === "provisional" && aiSaved[0].metadata?.origin === "extension_ai", aiSaved);

  section("9. Results");
  r = await result(LA.lease_id, { r: "SENT", hid: true, trace: ["0%", "50%"] });
  // The cap counts the day's tracker movement too: 7 at the draft's read, 10 at this run's (3 applications by hand).
  expect("SENT -> applied, continue; the cap counts the tracker's movement", r.body?.status === "applied" && r.body.next.type === "continue" && r.body.cap.left === 32, r.body);
  let a = await app("A");
  expect("...applied_by aupply, engine ext@<version>, hidden flag kept", a?.status === "applied" && a.applied_by === "aupply" && a.metadata.engine === `ext@${VERSION}` && a.metadata.hid === 1 && a.metadata.last_result === "SENT", a);
  const { data: qaRows } = await admin.from("application_questions").select("question, answer, answer_id, metadata").eq("application_id", appId.A);
  expect("...its Q&A is logged in application_questions", qaRows?.length === 12 && qaRows.some((q) => q.question === "Education end year" && q.answer === "2023") && qaRows.every((q) => q.metadata.origin === "extension") && qaRows.some((q) => q.metadata.source === "ai" && q.answer_id === aiSaved?.[0]?.id), qaRows?.map((q) => [q.question, q.metadata.source]));
  const again = await result(LA.lease_id, { r: "SENT" });
  const { count: qaCount } = await admin.from("application_questions").select("id", { count: "exact", head: true }).eq("application_id", appId.A);
  expect("posting the same result again: the stored outcome, nothing recorded twice", again.body?.status === "applied" && again.body.next.type === "continue" && qaCount === qaRows?.length, { again: again.body, qaCount });

  r = await next();
  const LB = r.body;
  const { data: la } = await admin.from("ext_leases").select("completed_at").eq("id", LA.lease_id).single();
  expect("the next job waits at least 30 seconds after the last one finished", LB?.job?.id === ids.B && Date.parse(LB.not_before) - Date.parse(la.completed_at) >= 29_900, { nb: LB?.not_before, done: la?.completed_at });
  r = await result(LB.lease_id, { r: "NO_EASY_APPLY" });
  expect("NO_EASY_APPLY on a strong match -> saved for the user", r.body?.status === "saved" && /strong match/.test(r.body.reason), r.body);

  r = await next();
  const LC = r.body;
  r = await result(LC.lease_id, { r: "STALL", errs: ["Please enter a valid answer"], trace: ["50%", "50%"] });
  a = await app("C");
  expect("STALL once -> the job stays queued, one failure, retried later", r.body?.status === "discovered" && a.metadata.fails === 1 && Date.parse(a.metadata.retry_after) > Date.now() + 10 * 60_000 && a.metadata.errs?.[0] === "Please enter a valid answer", a);

  r = await next();
  const LD = r.body;
  expect("a job waiting for its retry is not leased", LD?.job?.id === ids.D, LD);
  const dlField = { fid: "d1", kind: "radio", label: "Do you have a valid driver's license?", options: ["Yes", "No"], required: true };
  r = await answers(LD.lease_id, [dlField], "Upsilon Apps");
  const dlQ = r.body?.questions?.[0];
  expect("a driver's license question -> needs_input, never AI", r.body?.verdict === "needs_input" && r.body.ai_used === false && dlQ?.kind === "needs_input" && r.body.actions.some((x) => x.fid === "d1" && x.do === "leave"), r.body);
  r = await result(LD.lease_id, { r: "NEEDS_INPUT", need: [dlField.label], question_ids: [dlQ.id] });
  a = await app("D");
  expect("NEEDS_INPUT -> queued but waiting on the user", r.body?.status === "discovered" && a.metadata.needs_input?.join() === dlQ.id, a);

  r = await next();
  const LE = r.body;
  expect("...and a job waiting on the user is not leased", LE?.job?.id === ids.E, LE);
  r = await answers(LE.lease_id, [{ fid: "e1", kind: "text", label: "Date of birth", required: true }], "Phi Works");
  const dobQ = r.body?.questions?.[0];
  expect("a date of birth field -> protected", r.body?.verdict === "protected" && dobQ?.kind === "protected", r.body);
  const { data: dobRow } = await admin.from("ext_questions").select("key, kind").eq("id", dobQ?.id).single();
  expect("...an ext_questions row with key dob", dobRow?.key === "dob" && dobRow.kind === "protected", dobRow);
  r = await result(LE.lease_id, { r: "PROTECTED", need: ["Date of birth"] });
  expect("PROTECTED -> skipped, naming the fact", r.body?.status === "skipped" && /never invents: Date of birth/.test(r.body.reason), r.body);

  r = await next();
  const LJ = r.body;
  const fintech = { fid: "j1", kind: "radio", label: "Do you have experience in the fintech domain?", options: ["Yes", "No"], required: true };
  r = await answers(LJ.lease_id, [fintech], "Alpha Two");
  const finQ = r.body?.questions?.[0];
  expect("an industry domain question -> asked once, never AI", LJ?.job?.id === ids.J && r.body?.verdict === "needs_input" && r.body.ai_used === false, r.body);
  r = await result(LJ.lease_id, { r: "NEEDS_INPUT", question_ids: [finQ.id] });
  r = await http("GET", "/questions", { token: dev.access });
  const q = (id) => r.body?.items?.find((i) => i.id === id);
  expect("open questions list", q(dlQ.id)?.key === "drivers_license" && q(dlQ.id).options?.join() === "Yes,No" && q(dlQ.id).waiting_count === 1 && q(finQ.id)?.key === "domain.fintech" && q(dobQ.id)?.kind === "protected", r.body);
  r = await http("GET", "/me", { token: dev.access });
  expect("/me counts open questions and AI answers to review", r.body?.open_questions === 3 && r.body.provisional_to_review === 1 && r.body.linkedin.queue.waiting_on_you === 2, r.body);
  r = await http("POST", `/questions/${finQ.id}/dismiss`, { token: dev.access });
  a = await app("J");
  expect("dismissing a question skips the jobs waiting on it", r.body?.skipped === 1 && a.status === "skipped" && /needs your answer/.test(a.status_reason), a);
  r = await http("POST", `/questions/${dlQ.id}/answer`, { token: dev.access, json: { answer: "No" } });
  expect("answering a question releases the job", r.body?.ok === true && r.body.released === 1, r.body);
  const { data: dlAns } = await admin.from("answers").select("key, answer, status, source").eq("user_id", userId).eq("key", "drivers_license").single();
  expect("...saved as the user's own confirmed answer", dlAns?.answer === "No" && dlAns.status === "confirmed" && dlAns.source === "user", dlAns);
  a = await app("D");
  expect("...the job no longer waits", a.status === "discovered" && !a.metadata.needs_input, a.metadata);
  r = await next();
  const LD2 = r.body;
  expect("...and is leased again", LD2?.job?.id === ids.D && LD2.attempt === 1, LD2);
  r = await answers(LD2.lease_id, [dlField], "Upsilon Apps");
  expect("the saved answer fills the question now", r.body?.verdict === "fill" && r.body.actions[0]?.do === "choose" && r.body.actions[0].index === 1, r.body);
  r = await result(LD2.lease_id, { r: "SENT" });
  expect("...SENT", r.body?.status === "applied", r.body);

  r = await next();
  const LF = r.body;
  r = await result(LF.lease_id, { r: "RATE_LIMITED" });
  const { data: lb } = await admin.from("platform_state").select("blocked_until").eq("user_id", userId).eq("platform", "linkedin").single();
  expect("RATE_LIMITED once -> a 5 minute LinkedIn pause, continue", LF?.job?.id === ids.F && r.body?.next.type === "continue" && Date.parse(lb?.blocked_until) - Date.now() > 4 * 60_000, { r: r.body, lb });
  r = await next();
  expect("...apply/next waits out the pause", r.body?.type === "wait" && r.body.reason === "blocked", r.body);
  await clearBlocks();
  r = await next();
  const LG = r.body;
  expect("...then the run is slower: 8 second page waits", LG?.job?.id === ids.G && LG.page_wait_ms === 8000, LG);
  r = await result(LG.lease_id, { r: "RATE_LIMITED" });
  const { data: lb2 } = await admin.from("platform_state").select("blocked_until").eq("user_id", userId).eq("platform", "linkedin").single();
  expect("RATE_LIMITED twice -> a 180 minute pause and stop", r.body?.next.type === "stop" && r.body.next.reason === "rate_limited" && Date.parse(lb2?.blocked_until) - Date.now() > 170 * 60_000, { r: r.body, lb2 });
  r = await next();
  expect("...apply/next ends the run while it lasts", r.body?.type === "done" && r.body.reason === "blocked", r.body);
  await park("G");
  await clearBlocks();

  r = await next();
  const LH = r.body;
  r = await result(LH.lease_id, { r: "DAILY_LIMIT" });
  const { data: lb3 } = await admin.from("platform_state").select("blocked_until, block_reason").eq("user_id", userId).eq("platform", "linkedin").single();
  expect("DAILY_LIMIT -> blocked until the end of the user's day, stop", LH?.job?.id === ids.H && r.body?.next.type === "stop" && r.body.next.reason === "cap" && /daily/i.test(lb3?.block_reason ?? ""), { r: r.body, lb3 });
  await park("H");
  await clearBlocks();

  r = await next();
  expect("a tracker read after 10 apply leases in the run", r.body?.type === "tracker", r.body);
  await http("POST", "/linkedin/tracker", { token: dev.access, json: { lease_id: r.body.lease_id, count: 12 } });

  await touchApp(appId.C, { metadata: { retry_after: new Date(Date.now() - 1000).toISOString() } });
  r = await next();
  const LC2 = r.body;
  r = await result(LC2.lease_id, { r: "STALL" });
  a = await app("C");
  expect("STALL twice -> failed", LC2?.job?.id === ids.C && LC2.attempt === 2 && r.body?.status === "failed" && a.status === "failed", { LC2, a });

  r = await next();
  const LK = r.body;
  await admin.from("ext_leases").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", LK.lease_id);
  r = await next();
  a = await app("K");
  expect("an apply lease that expired (the extension vanished) counts as ERR, and the job waits for its retry", LK?.job?.id === ids.K && a.metadata.fails === 1 && a.metadata.last_result === "ERR" && a.metadata.e === "lease_expired" && a.metadata.retry_after && r.body?.job?.id === ids.V, { meta: a.metadata, next: r.body });
  const LV = r.body;
  r = await result(LV.lease_id, { r: "UNCONFIRMED" });
  expect("UNCONFIRMED -> unconfirmed", r.body?.status === "unconfirmed", r.body);
  r = await next();
  const LV2 = r.body;
  expect("with the queue empty, an UNCONFIRMED job of this run is visited again to verify it", LV2?.type === "job" && LV2.job.id === ids.V && LV2.verify === true, LV2);
  r = await result(LV2.lease_id, { r: "ALREADY_APPLIED" });
  a = await app("V");
  expect("...ALREADY_APPLIED there settles it as applied (still Aupply's), verified once", r.body?.status === "applied" && a.applied_by === "aupply" && a.metadata.verified === true, a);
  r = await next();
  expect("...and the run's last tracker read comes before it ends", r.body?.type === "tracker", r.body);
  await http("POST", "/linkedin/tracker", { token: dev.access, json: { lease_id: r.body.lease_id, count: 13 } });
  r = await next();
  expect("nothing left to apply to -> done (queue_empty)", r.body?.type === "done" && r.body.reason === "queue_empty", r.body);

  const today = new Date().toISOString();
  await admin.from("applications").insert(
    Array.from({ length: 35 }, (_, i) => ({
      user_id: userId, platform: "linkedin", external_id: String(B + 50 + i), company_name: "Cap Filler", job_title: "Backend Engineer",
      status: "applied", applied_by: "aupply", applied_at: today, metadata: { channel: "extension", engine: `ext@${VERSION}`, ...extAt() },
    }))
  );
  testJobIds.push(...Array.from({ length: 35 }, (_, i) => String(B + 50 + i)));
  await touchApp(appId.K, { metadata: { retry_after: new Date(Date.now() - 1000).toISOString() } });
  r = await next();
  expect("the daily cap reached (35 today) -> done (cap)", r.body?.type === "done" && r.body.reason === "cap", r.body);

  section("10. Session end and cleanup cron");
  r = await http("POST", "/session/end", { token: dev.access, json: { run_id: runId, reason: "cap" } });
  expect(
    "session/end: counts, the job saved for the user, provisional answers used",
    r.body?.counts?.applied === 3 && r.body.counts.saved === 1 && r.body.counts.failed === 1 && r.body.saved_for_you?.[0]?.title === "Backend Engineer" &&
      r.body.provisional_used?.some((p) => p.question === "Why do you want to join Rho Tech?") && !r.body.tracker_mismatch,
    r.body
  );
  section("Review");
  r = await http("GET", "/answers/review", { token: dev.access });
  const review = r.body?.items?.[0];
  expect("the AI's answers are listed for review", r.body?.items?.length === 1 && review.question === "Why do you want to join Rho Tech?", r.body);
  r = await http("POST", `/answers/${review?.id}/confirm`, { token: dev.access, json: { answer: "I like what Rho Tech builds and it fits my Node.js work." } });
  const { data: conf } = await admin.from("answers").select("status, answer").eq("id", review?.id).single();
  expect("confirm with an edit", r.status === 200 && conf?.status === "confirmed" && conf.answer.startsWith("I like"), conf);

  r = await http("GET", "/cron/cleanup", { version: null });
  expect("cron without CRON_SECRET -> 401", r.status === 401, r.body);
  r = await http("GET", "/cron/cleanup", { version: null, headers: { Authorization: "Bearer wrong" } });
  expect("cron with a wrong secret -> 401", r.status === 401, r.body);
  r = await http("GET", "/cron/cleanup", { version: null, headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  expect("cron with CRON_SECRET runs the cleanup", r.status === 200 && r.body.ok === true && typeof r.body.events_deleted === "number", r.body);
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
