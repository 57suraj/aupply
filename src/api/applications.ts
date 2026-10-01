/**
 * Application and event routes (mounted at /api, behind requireUser):
 *
 *   GET    /applications?status=a,b&stage=&platform=&q=&since=&limit=&offset=&sort=created|applied
 *   GET    /applications/stats
 *   POST   /applications/check           { platform?, external_ids?, companies? }
 *   POST   /applications                 manual add (upserts on platform + external_id)
 *   GET    /applications/:id             with events and screening questions
 *   PATCH  /applications/:id
 *   POST   /applications/:id/apply       the user applied to a saved job by hand
 *   DELETE /applications/:id
 *   POST   /applications/:id/events      record an outcome or note
 *   GET    /events?pending=true&limit=
 *   PATCH  /events/:id                   e.g. { action_done: true }
 *   DELETE /events/:id
 */

import { Router } from "express";
import { z } from "zod";
import {
  ApplicationInput,
  ApplicationListQuery,
  ApplicationPatch,
  EventFields,
  EventPatch,
} from "../domain/schemas.js";
import * as applications from "../services/applications.js";
import { boolParam, idParam, intParam, listParam, strParam, userId } from "./http.js";

export const applicationsRouter = Router();

applicationsRouter.get("/applications", async (req, res) => {
  const query = ApplicationListQuery.parse({
    status: listParam(req.query.status),
    stage: listParam(req.query.stage),
    platform: strParam(req.query.platform),
    q: strParam(req.query.q),
    since: strParam(req.query.since),
    limit: intParam(req.query.limit),
    offset: intParam(req.query.offset),
    sort: strParam(req.query.sort),
  });
  res.json(await applications.listApplications(userId(res), query));
});

applicationsRouter.get("/applications/stats", async (_req, res) => {
  res.json(await applications.getStats(userId(res)));
});

const CheckBody = z
  .object({
    platform: z.string().trim().toLowerCase().optional(),
    external_ids: z.array(z.string().max(200)).max(500).optional(),
    companies: z.array(z.string().max(300)).max(200).optional(),
  })
  .strict();

applicationsRouter.post("/applications/check", async (req, res) => {
  res.json(await applications.checkExisting(userId(res), CheckBody.parse(req.body)));
});

applicationsRouter.post("/applications", async (req, res) => {
  res.status(201).json(await applications.logApplication(userId(res), ApplicationInput.parse(req.body)));
});

applicationsRouter.get("/applications/:id", async (req, res) => {
  res.json(await applications.getApplication(userId(res), idParam(req)));
});

applicationsRouter.patch("/applications/:id", async (req, res) => {
  res.json(await applications.updateApplication(userId(res), idParam(req), ApplicationPatch.parse(req.body)));
});

applicationsRouter.post("/applications/:id/apply", async (req, res) => {
  res.json(await applications.applyByHand(userId(res), idParam(req)));
});

applicationsRouter.delete("/applications/:id", async (req, res) => {
  await applications.deleteApplication(userId(res), idParam(req));
  res.status(204).end();
});

applicationsRouter.post("/applications/:id/events", async (req, res) => {
  const fields = EventFields.strict().parse(req.body);
  res
    .status(201)
    .json(await applications.recordEvent(userId(res), { ...fields, application_id: idParam(req) }, "manual"));
});

applicationsRouter.get("/events", async (req, res) => {
  res.json(
    await applications.listEvents(userId(res), {
      pending: boolParam(req.query.pending),
      limit: intParam(req.query.limit),
    })
  );
});

applicationsRouter.patch("/events/:id", async (req, res) => {
  res.json(await applications.updateEvent(userId(res), idParam(req), EventPatch.parse(req.body)));
});

applicationsRouter.delete("/events/:id", async (req, res) => {
  await applications.deleteEvent(userId(res), idParam(req));
  res.status(204).end();
});
