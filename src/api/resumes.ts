/**
 * Resume routes (mounted at /api, behind requireUser):
 *
 *   GET    /resumes?include_archived=true
 *   POST   /resumes                     { label?, content?, is_default? }
 *   GET    /resumes/:id
 *   PATCH  /resumes/:id                 { label?, content?, is_default?, archived? }
 *   DELETE /resumes/:id                 also deletes the stored file
 *   POST   /resumes/:id/upload-url      { file_name } -> { path, token, signedUrl }
 *   POST   /resumes/:id/file            { path, replace_content? } after uploading
 *   GET    /resumes/:id/download-url
 *
 * Upload flow: create the resume, get an upload URL, upload with
 * supabase.storage.from("resumes").uploadToSignedUrl(path, token, file),
 * then POST /file so the server records it and extracts the text.
 */

import { Router } from "express";
import { z } from "zod";
import { ResumeInput, ResumePatch } from "../domain/schemas.js";
import * as resumes from "../services/resumes.js";
import { boolParam, idParam, userId } from "./http.js";

export const resumesRouter = Router();

resumesRouter.get("/resumes", async (req, res) => {
  res.json(await resumes.listResumes(userId(res), boolParam(req.query.include_archived) ?? false));
});

resumesRouter.post("/resumes", async (req, res) => {
  res.status(201).json(await resumes.createResume(userId(res), ResumeInput.parse(req.body)));
});

resumesRouter.get("/resumes/:id", async (req, res) => {
  res.json(await resumes.getResume(userId(res), idParam(req)));
});

resumesRouter.patch("/resumes/:id", async (req, res) => {
  res.json(await resumes.updateResume(userId(res), idParam(req), ResumePatch.parse(req.body)));
});

resumesRouter.delete("/resumes/:id", async (req, res) => {
  await resumes.deleteResume(userId(res), idParam(req));
  res.status(204).end();
});

const UploadUrlBody = z.object({ file_name: z.string().min(1).max(200) }).strict();

resumesRouter.post("/resumes/:id/upload-url", async (req, res) => {
  const { file_name } = UploadUrlBody.parse(req.body);
  res.json(await resumes.createUploadUrl(userId(res), idParam(req), file_name));
});

const FinalizeBody = z.object({ path: z.string().min(1), replace_content: z.boolean().optional() }).strict();

resumesRouter.post("/resumes/:id/file", async (req, res) => {
  const body = FinalizeBody.parse(req.body);
  res.json(
    await resumes.finalizeUpload(userId(res), idParam(req), {
      path: body.path,
      replaceContent: body.replace_content,
    })
  );
});

resumesRouter.get("/resumes/:id/download-url", async (req, res) => {
  res.json(await resumes.createDownloadUrl(userId(res), idParam(req)));
});
