/**
 * Account routes (mounted at /api, behind requireUser):
 *
 *   GET    /runs?limit=              Claude sessions, newest first
 *   GET    /connections              apps authorized via OAuth (e.g. Claude)
 *   DELETE /connections/:id          revoke; its tokens stop working at once
 */

import { Router } from "express";
import { listRuns } from "../services/runs.js";
import { listConnections, revokeConnection } from "../services/connections.js";
import { idParam, intParam, userId } from "./http.js";

export const accountRouter = Router();

accountRouter.get("/runs", async (req, res) => {
  res.json(await listRuns(userId(res), intParam(req.query.limit) ?? 50));
});

accountRouter.get("/connections", async (_req, res) => {
  res.json(await listConnections(userId(res)));
});

accountRouter.delete("/connections/:id", async (req, res) => {
  await revokeConnection(userId(res), idParam(req));
  res.status(204).end();
});
