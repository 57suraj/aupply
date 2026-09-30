/**
 * Resumes: several variants per user, one default.
 *
 * Files live in the private `resumes` storage bucket at
 * <user_id>/<resume_id>/<file_name>. The browser uploads directly with a
 * signed upload URL, then calls finalizeUpload so the server records the file
 * and extracts its text into `content` (what Claude reads). PDF, plain text
 * DOCX and Markdown are extracted; other formats (e.g. legacy .doc) keep the file only.
 */

import type { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { AppError, check, notFound, unwrap, unwrapMaybe } from "../lib/errors.js";
import type { ResumeInput, ResumePatch } from "../domain/schemas.js";
import { escapeLike } from "./answers.js";

const BUCKET = "resumes";
const db = () => getSupabaseClient();

/** List view omits the full text; `content_chars` says whether it exists. */
export async function listResumes(userId: string, includeArchived = false) {
  let query = db()
    .from("resumes")
    .select("id, label, file_name, mime_type, file_size_bytes, is_default, archived_at, created_at, updated_at, content")
    .eq("user_id", userId);
  if (!includeArchived) query = query.is("archived_at", null);
  const rows = unwrap(await query.order("is_default", { ascending: false }).order("created_at", { ascending: false }));
  return rows.map(({ content, ...rest }) => ({ ...rest, content_chars: content?.length ?? 0 }));
}

export async function getResume(userId: string, id: string) {
  const row = unwrapMaybe(await db().from("resumes").select("*").eq("id", id).eq("user_id", userId).maybeSingle());
  if (!row) throw notFound("Resume");
  return row;
}

/** The resume Claude should use: by id, else by label, else the default, else the newest. */
export async function pickResume(userId: string, params: { id?: string; label?: string }) {
  if (params.id) return getResume(userId, params.id);
  let query = db().from("resumes").select("*").eq("user_id", userId).is("archived_at", null);
  if (params.label) query = query.ilike("label", escapeLike(params.label));
  const row = unwrapMaybe(
    await query
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  if (!row) throw notFound(params.label ? `Resume labelled "${params.label}"` : "Resume");
  return row;
}

export async function createResume(userId: string, input: z.infer<typeof ResumeInput>) {
  // The first resume becomes the default automatically.
  const { count } = await db().from("resumes").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return unwrap(
    await db()
      .from("resumes")
      .insert({
        ...input,
        structured: input.structured as Json | undefined,
        metadata: input.metadata as Json | undefined,
        is_default: input.is_default ?? (count ?? 0) === 0,
        user_id: userId,
      })
      .select("*")
      .single()
  );
}

export async function updateResume(userId: string, id: string, patch: z.infer<typeof ResumePatch>) {
  const { archived, structured, metadata, ...fields } = patch;
  const row = unwrapMaybe(
    await db()
      .from("resumes")
      .update({
        ...fields,
        ...(structured !== undefined ? { structured: structured as Json } : {}),
        ...(metadata ? { metadata: metadata as Json } : {}),
        ...(archived !== undefined ? { archived_at: archived ? new Date().toISOString() : null } : {}),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle()
  );
  if (!row) throw notFound("Resume");
  return row;
}

export async function deleteResume(userId: string, id: string) {
  const resume = await getResume(userId, id);
  if (resume.file_path) {
    await db().storage.from(BUCKET).remove([resume.file_path]);
  }
  check(await db().from("resumes").delete().eq("id", id).eq("user_id", userId));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const safeFileName = (name: string) =>
  name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(-120) || "resume";

/** Signed URL the browser can PUT the file to (supabase.storage uploadToSignedUrl). */
export async function createUploadUrl(userId: string, id: string, fileName: string) {
  await getResume(userId, id);
  const path = `${userId}/${id}/${safeFileName(fileName)}`;
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw new AppError(`Could not create upload URL: ${error?.message}`, 500);
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

async function extractResumeText(bytes: Uint8Array, mimeType: string, fileName: string): Promise<string | null> {
  const lower = fileName.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim() || null;
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value.trim() || null;
  }
  if (mimeType.startsWith("text/") || lower.endsWith(".md") || lower.endsWith(".txt")) {
    return new TextDecoder().decode(bytes).trim() || null;
  }
  return null;
}

/** Record an uploaded file on the resume and extract its text. */
export async function finalizeUpload(
  userId: string,
  id: string,
  params: { path: string; replaceContent?: boolean }
) {
  const resume = await getResume(userId, id);
  if (!params.path.startsWith(`${userId}/${id}/`)) {
    throw new AppError("File path does not belong to this resume.", 400);
  }

  const { data: blob, error } = await db().storage.from(BUCKET).download(params.path);
  if (error || !blob) throw new AppError("Uploaded file not found. Upload it first.", 400);

  if (resume.file_path && resume.file_path !== params.path) {
    await db().storage.from(BUCKET).remove([resume.file_path]);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fileName = params.path.split("/").pop() || "resume";
  const mimeType = blob.type || "application/octet-stream";

  let extracted: string | null = null;
  let extractionError: string | null = null;
  try {
    extracted = await extractResumeText(bytes, mimeType, fileName);
  } catch (err) {
    extractionError = err instanceof Error ? err.message : "Text extraction failed.";
  }

  const shouldReplace = extracted && (params.replaceContent || !resume.content);
  const updated = unwrap(
    await db()
      .from("resumes")
      .update({
        file_path: params.path,
        file_name: fileName,
        mime_type: mimeType,
        file_size_bytes: bytes.byteLength,
        ...(shouldReplace ? { content: extracted } : {}),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .single()
  );
  return {
    resume: updated,
    text_extracted: Boolean(extracted),
    content_replaced: Boolean(shouldReplace),
    extraction_error: extractionError,
  };
}

export async function createDownloadUrl(userId: string, id: string) {
  const resume = await getResume(userId, id);
  if (!resume.file_path) throw new AppError("This resume has no file.", 404, "not_found");
  const { data, error } = await db().storage.from(BUCKET).createSignedUrl(resume.file_path, 300);
  if (error || !data) throw new AppError("Could not create download URL.", 500);
  return { url: data.signedUrl, expires_in: 300 };
}
