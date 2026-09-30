/**
 * Candidate routes (mounted at /api, behind requireUser):
 *
 *   GET    /profile                   profile + work history + education + canonical answers
 *   PATCH  /profile
 *   GET    /experiences               POST /experiences   PATCH|DELETE /experiences/:id
 *   GET    /educations                POST /educations    PATCH|DELETE /educations/:id
 *   GET    /preferences               PATCH /preferences
 */

import { Router } from "express";
import {
  EducationInput,
  EducationPatch,
  ExperienceInput,
  ExperiencePatch,
  PreferencesPatch,
  ProfilePatch,
} from "../domain/schemas.js";
import * as candidate from "../services/candidate.js";
import { idParam, userId } from "./http.js";

export const candidateRouter = Router();

candidateRouter.get("/profile", async (_req, res) => {
  res.json(await candidate.getCandidateProfile(userId(res)));
});

candidateRouter.patch("/profile", async (req, res) => {
  res.json(await candidate.updateProfile(userId(res), ProfilePatch.parse(req.body)));
});

candidateRouter.get("/experiences", async (_req, res) => {
  res.json(await candidate.listExperiences(userId(res)));
});

candidateRouter.post("/experiences", async (req, res) => {
  res.status(201).json(await candidate.createExperience(userId(res), ExperienceInput.parse(req.body)));
});

candidateRouter.patch("/experiences/:id", async (req, res) => {
  res.json(await candidate.updateExperience(userId(res), idParam(req), ExperiencePatch.parse(req.body)));
});

candidateRouter.delete("/experiences/:id", async (req, res) => {
  await candidate.deleteExperience(userId(res), idParam(req));
  res.status(204).end();
});

candidateRouter.get("/educations", async (_req, res) => {
  res.json(await candidate.listEducations(userId(res)));
});

candidateRouter.post("/educations", async (req, res) => {
  res.status(201).json(await candidate.createEducation(userId(res), EducationInput.parse(req.body)));
});

candidateRouter.patch("/educations/:id", async (req, res) => {
  res.json(await candidate.updateEducation(userId(res), idParam(req), EducationPatch.parse(req.body)));
});

candidateRouter.delete("/educations/:id", async (req, res) => {
  await candidate.deleteEducation(userId(res), idParam(req));
  res.status(204).end();
});

candidateRouter.get("/preferences", async (_req, res) => {
  res.json(await candidate.getPreferences(userId(res)));
});

candidateRouter.patch("/preferences", async (req, res) => {
  res.json(await candidate.updatePreferences(userId(res), PreferencesPatch.parse(req.body)));
});
