/**
 * Saved answer routes (mounted at /api, behind requireUser):
 *
 *   GET    /answers?q=&category=&status=&keyed=true|false
 *   GET    /answers/similar?q=&limit=    fuzzy match incl. past application answers
 *   POST   /answers
 *   PATCH  /answers/:id                  e.g. { status: "confirmed" } to confirm a guess
 *   DELETE /answers/:id
 */

import { Router } from "express";
import { z } from "zod";
import { AnswerInput, AnswerPatch } from "../domain/schemas.js";
import * as answers from "../services/answers.js";
import { boolParam, idParam, intParam, strParam, userId } from "./http.js";

export const answersRouter = Router();

answersRouter.get("/answers", async (req, res) => {
  res.json(
    await answers.listAnswers(userId(res), {
      q: strParam(req.query.q),
      category: strParam(req.query.category),
      status: strParam(req.query.status),
      keyed: boolParam(req.query.keyed),
    })
  );
});

answersRouter.get("/answers/similar", async (req, res) => {
  const q = z.string().min(2).max(2000).parse(req.query.q);
  const limit = Math.min(Math.max(intParam(req.query.limit) ?? 5, 1), 20);
  res.json(await answers.findSimilarAnswers(userId(res), q, limit));
});

answersRouter.post("/answers", async (req, res) => {
  res.status(201).json(await answers.createAnswer(userId(res), AnswerInput.parse(req.body), "user"));
});

answersRouter.patch("/answers/:id", async (req, res) => {
  res.json(await answers.updateAnswer(userId(res), idParam(req), AnswerPatch.parse(req.body)));
});

answersRouter.delete("/answers/:id", async (req, res) => {
  await answers.deleteAnswer(userId(res), idParam(req));
  res.status(204).end();
});
