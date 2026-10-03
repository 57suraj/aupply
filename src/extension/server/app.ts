/**
 * The extension channel's Express app (decision E2): its own Vercel function (api/ext.ts),
 * routed by one rewrite of /ext/* in vercel.json. It shares the database and imports the
 * MCP's platform-level logic read-only; it never touches the MCP app (src/app.ts).
 *
 * Routes (all under /ext/v1; contract in src/extension/contract.ts):
 *   GET  /health
 *   Pairing and tokens (no auth): POST /pair/start  /pair/poll  /token/refresh
 *   Website (Supabase session): GET|POST /web/pair/:code  GET /web/devices
 *     DELETE /web/devices/:id  GET /web/extension
 *   Device (device token + version gate): POST /device/signout  PATCH /device  GET /me
 *     POST /onboarding/propose  /onboarding/save  POST /events
 *     POST /session/start  /session/heartbeat  /session/end  POST /linkedin/tracker
 *     POST /linkedin/draft/start  /linkedin/draft/next  GET /linkedin/queue
 *     POST /linkedin/queue/:id/skip  GET|POST /linkedin/decisions
 *     POST /linkedin/apply/next  /linkedin/apply/answers  /linkedin/apply/result
 *     GET /questions  POST /questions/:id/answer  /questions/:id/dismiss
 *     GET /answers/review  POST /answers/:id/confirm
 *   Cron (Bearer CRON_SECRET): GET /cron/cleanup
 */

import "dotenv/config";
import express, { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { requireUser, sessionUser } from "../../auth/supabaseUser.js";
import { pollPairing, refreshTokens, startPairing, webPairDecide, webPairInfo } from "../auth/pairing.js";
import { deviceOf, requireDevice } from "../auth/requireDevice.js";
import {
  AnswersRequest,
  ApplyNextRequest,
  ApplyResultRequest,
  ConfirmRequest,
  DecisionsRequest,
  DraftNextRequest,
  DraftStartRequest,
  EventsRequest,
  HeartbeatRequest,
  POSTED_WITHIN,
  SessionEndRequest,
  SessionStartRequest,
  TrackerRequest,
  PairPollRequest,
  PairStartRequest,
  QuestionAnswerRequest,
  RefreshRequest,
  RenameDeviceRequest,
  WebPairDecision,
  type HealthResponse,
  type WebExtensionInfo,
} from "../contract.js";
import { defaultWithin } from "../../platforms/config.js";
import { getPreferences } from "../../services/candidate.js";
import { applyNext, applyResult, recordTracker } from "../services/apply.js";
import { cleanupAll, requireCron } from "../services/cleanup.js";
import { nextDraft, startDraft } from "../services/draft.js";
import { queueView, skipQueued } from "../services/queue.js";
import { answerPage } from "../services/formAnswers.js";
import { answerQuestion, confirmAnswer, decide, dismissQuestion, listDecisions, listQuestions, listReview } from "../services/questions.js";
import { endSession, heartbeat, startSession } from "../services/sessions.js";
import { listDevices, renameDevice, revokeDevice } from "../services/devices.js";
import { logClientEvents } from "../services/events.js";
import { me } from "../services/me.js";
import { proposeOnboarding, saveOnboarding } from "../services/onboarding.js";
import { selfCheck } from "../engine/modules.js";
import { EXT_VERSION } from "../version.js";
import { DOWNLOAD_PATH, extErrorHandler, minVersion, versionGate } from "./http.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// CORS. Auth is bearer tokens only, never cookies, so a wildcard origin is safe.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Aupply-Ext-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Vercel's body limit is 4.5MB; JD batches are the largest bodies.
app.use(express.json({ limit: "4mb" }));

const v1 = Router();
/** Device endpoints: version gate first (an outdated extension is told to update before anything else). */
const device: RequestHandler[] = [versionGate, requireDevice];
const uuidParam = (req: Request, name = "id") => z.string().uuid().parse(req.params[name]);
const userOf = (res: Response) => sessionUser(res).id;

// The built engine definitions the server relies on (clean, yearsOf, payMax, NEVERTICK,
// CONSENT), checked once per process and reported by /health.
const engineFails = selfCheck();
if (engineFails.length) console.error("[ext] engine self-check failed:", engineFails.join(", "));

v1.get("/health", (_req, res) => {
  res.json({ ok: true, version: EXT_VERSION, min_ext_version: minVersion(), engine: { ok: !engineFails.length, fails: engineFails } } satisfies HealthResponse);
});

// ---------------------------------------------------------------------------
// Pairing and tokens (no auth)
// ---------------------------------------------------------------------------
v1.post("/pair/start", async (req, res) => {
  res.json(await startPairing(PairStartRequest.parse(req.body), req.ip ?? "unknown"));
});
v1.post("/pair/poll", async (req, res) => {
  const { pair_id, poll_secret } = PairPollRequest.parse(req.body);
  res.json(await pollPairing(pair_id, poll_secret));
});
v1.post("/token/refresh", async (req, res) => {
  res.json(await refreshTokens(RefreshRequest.parse(req.body).refresh_token));
});

// ---------------------------------------------------------------------------
// Website (Supabase session)
// ---------------------------------------------------------------------------
const web = Router();
web.use(requireUser);
web.get("/pair/:code", async (req, res) => {
  res.json(await webPairInfo(userOf(res), String(req.params.code)));
});
web.post("/pair/:code", async (req, res) => {
  res.json(await webPairDecide(userOf(res), String(req.params.code), WebPairDecision.parse(req.body).approve));
});
web.get("/devices", async (_req, res) => {
  res.json(await listDevices(userOf(res)));
});
web.delete("/devices/:id", async (req, res) => {
  await revokeDevice(userOf(res), uuidParam(req), "web");
  res.status(204).end();
});
web.get("/extension", (_req, res) => {
  res.json({ latest_version: EXT_VERSION, min_version: minVersion(), download_url: DOWNLOAD_PATH } satisfies WebExtensionInfo);
});
v1.use("/web", web);

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------
v1.post("/device/signout", ...device, async (_req, res) => {
  const d = deviceOf(res);
  await revokeDevice(d.userId, d.deviceId, "signout");
  res.json({ ok: true });
});
v1.patch("/device", ...device, async (req, res) => {
  const d = deviceOf(res);
  res.json(await renameDevice(d.userId, d.deviceId, RenameDeviceRequest.parse(req.body).name));
});
v1.get("/me", ...device, async (_req, res) => {
  res.json(await me(deviceOf(res)));
});
v1.post("/onboarding/propose", ...device, async (_req, res) => {
  res.json(await proposeOnboarding(deviceOf(res).userId));
});
v1.post("/onboarding/save", ...device, async (req, res) => {
  res.json(await saveOnboarding(deviceOf(res).userId, req.body));
});
v1.post("/session/start", ...device, async (req, res) => {
  res.json(await startSession(deviceOf(res), SessionStartRequest.parse(req.body)));
});
v1.post("/session/heartbeat", ...device, async (req, res) => {
  res.json(await heartbeat(deviceOf(res), HeartbeatRequest.parse(req.body)));
});
v1.post("/session/end", ...device, async (req, res) => {
  res.json(await endSession(deviceOf(res), SessionEndRequest.parse(req.body)));
});
v1.post("/linkedin/tracker", ...device, async (req, res) => {
  res.json(await recordTracker(deviceOf(res), TrackerRequest.parse(req.body)));
});
v1.post("/linkedin/draft/start", ...device, async (req, res) => {
  res.json(await startDraft(deviceOf(res), DraftStartRequest.parse(req.body)));
});
v1.post("/linkedin/draft/next", ...device, async (req, res) => {
  res.json(await nextDraft(deviceOf(res), DraftNextRequest.parse(req.body)));
});
v1.get("/linkedin/queue", ...device, async (req, res) => {
  const d = deviceOf(res);
  const asked = z.enum(POSTED_WITHIN).safeParse(req.query.posted_within);
  const within = asked.success ? asked.data : defaultWithin((await getPreferences(d.userId)).max_posting_age_hours);
  res.json(await queueView(d.userId, within));
});
v1.post("/linkedin/queue/:id/skip", ...device, async (req, res) => {
  res.json(await skipQueued(deviceOf(res).userId, uuidParam(req)));
});
v1.get("/linkedin/decisions", ...device, async (_req, res) => {
  res.json(await listDecisions(deviceOf(res).userId));
});
v1.post("/linkedin/decisions", ...device, async (req, res) => {
  res.json(await decide(deviceOf(res).userId, DecisionsRequest.parse(req.body).items));
});
v1.post("/linkedin/apply/next", ...device, async (req, res) => {
  res.json(await applyNext(deviceOf(res), ApplyNextRequest.parse(req.body)));
});
v1.post("/linkedin/apply/answers", ...device, async (req, res) => {
  res.json(await answerPage(deviceOf(res), AnswersRequest.parse(req.body)));
});
v1.post("/linkedin/apply/result", ...device, async (req, res) => {
  res.json(await applyResult(deviceOf(res), ApplyResultRequest.parse(req.body)));
});
v1.get("/questions", ...device, async (_req, res) => {
  res.json(await listQuestions(deviceOf(res).userId));
});
v1.post("/questions/:id/answer", ...device, async (req, res) => {
  res.json(await answerQuestion(deviceOf(res).userId, uuidParam(req), QuestionAnswerRequest.parse(req.body).answer));
});
v1.post("/questions/:id/dismiss", ...device, async (req, res) => {
  res.json(await dismissQuestion(deviceOf(res).userId, uuidParam(req)));
});
v1.get("/answers/review", ...device, async (_req, res) => {
  res.json(await listReview(deviceOf(res).userId));
});
v1.post("/answers/:id/confirm", ...device, async (req, res) => {
  res.json(await confirmAnswer(deviceOf(res).userId, uuidParam(req), ConfirmRequest.parse(req.body ?? {}).answer));
});
v1.post("/events", ...device, async (req, res) => {
  const d = deviceOf(res);
  res.json(await logClientEvents(d.userId, d.deviceId, EventsRequest.parse(req.body).events));
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------
v1.get("/cron/cleanup", async (req, res) => {
  requireCron(req);
  res.json(await cleanupAll());
});

app.use("/ext/v1", v1);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Not found." } });
});
app.use(extErrorHandler);

export default app;
