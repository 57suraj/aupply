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
}

async function cleanup() {
  section("Cleanup");
  try {
    if (pairIds.length) await admin.from("ext_pairings").delete().in("id", pairIds);
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
