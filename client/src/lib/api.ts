import { supabase } from "./supabase";

/**
 * Lightweight API helpers that talk to our Express backend.
 * Each call attaches the current Supabase session token as Bearer auth.
 */

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// User / profile
// ---------------------------------------------------------------------------

export async function fetchMe() {
  const res = await fetch("/api/user/me", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** JSON request to our API; throws with the server's error message. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: await authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Resumes
// ---------------------------------------------------------------------------

export interface ResumeSummary {
  id: string;
  label: string;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  content_chars: number;
}

export interface Resume extends Omit<ResumeSummary, "content_chars"> {
  content: string | null;
  file_path: string | null;
}

export interface ResumeUploadResult {
  resume: Resume;
  text_extracted: boolean;
  content_replaced: boolean;
  extraction_error: string | null;
}

export const RESUME_ACCEPT = ".pdf,.docx,.doc,.txt,.md";
export const RESUME_MAX_BYTES = 10 * 1024 * 1024; // matches the storage bucket limit

const RESUME_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
  md: "text/markdown",
};

/** The MIME type the storage bucket expects, or null if the file type is not allowed. */
export function resumeMimeType(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return RESUME_MIME[ext] ?? null;
}

export const listResumes = () => request<ResumeSummary[]>("GET", "/api/resumes");
export const getResume = (id: string) => request<Resume>("GET", `/api/resumes/${id}`);
export const createResume = (body: { label?: string; content?: string; is_default?: boolean }) =>
  request<Resume>("POST", "/api/resumes", body);
export const updateResume = (
  id: string,
  body: { label?: string; content?: string | null; is_default?: boolean }
) => request<Resume>("PATCH", `/api/resumes/${id}`, body);
export const deleteResume = (id: string) => request<void>("DELETE", `/api/resumes/${id}`);
export const getResumeDownloadUrl = (id: string) =>
  request<{ url: string }>("GET", `/api/resumes/${id}/download-url`);

/**
 * Upload a resume file. Without resumeId a new resume (variant) is created;
 * with it, that resume's file is replaced. The file goes straight to Supabase
 * Storage through a signed URL, then the server records it and extracts text.
 */
export async function uploadResumeFile(
  file: File,
  opts: { resumeId?: string; label?: string } = {}
): Promise<ResumeUploadResult> {
  const contentType = resumeMimeType(file.name);
  if (!contentType) throw new Error("Upload a PDF, DOCX, DOC, TXT or MD file.");
  if (file.size > RESUME_MAX_BYTES) throw new Error("The file is larger than 10 MB.");

  let resumeId = opts.resumeId;
  const created = !resumeId;
  if (!resumeId) {
    resumeId = (await createResume({ label: opts.label })).id;
  }

  try {
    const { path, token } = await request<{ path: string; token: string }>(
      "POST",
      `/api/resumes/${resumeId}/upload-url`,
      { file_name: file.name }
    );
    const { error } = await supabase.storage
      .from("resumes")
      .uploadToSignedUrl(path, token, file, { contentType, upsert: true });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    return await request<ResumeUploadResult>("POST", `/api/resumes/${resumeId}/file`, {
      path,
      replace_content: true,
    });
  } catch (err) {
    // Don't leave an empty resume behind when a brand-new upload fails.
    if (created) await deleteResume(resumeId).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface Application {
  id: string;
  platform: string;
  external_id: string | null;
  job_url: string | null;
  company_name: string;
  job_title: string;
  location: string | null;
  status: string;
  status_reason: string | null;
  applied_at: string | null;
  /** "user": the user applied by hand (from the dashboard); "aupply": an engine or Claude. */
  applied_by: "aupply" | "user" | null;
  created_at: string;
}

export const listApplications = (params: { status: string[]; sort?: "created" | "applied"; limit?: number }) =>
  request<{ items: Application[]; total: number }>(
    "GET",
    `/api/applications?${new URLSearchParams({
      status: params.status.join(","),
      sort: params.sort ?? "created",
      limit: String(params.limit ?? 50),
    })}`
  );

/** The user applied to a saved job by hand: recorded as applied, by the user. */
export const applyByHand = (id: string) => request<Application>("POST", `/api/applications/${id}/apply`);

// ---------------------------------------------------------------------------
// Stripe / subscriptions
// ---------------------------------------------------------------------------

export async function createCheckoutSession(): Promise<{ url: string }> {
  const res = await fetch("/api/stripe/create-checkout-session", {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createBillingPortalSession(): Promise<{ url: string }> {
  const res = await fetch("/api/stripe/billing-portal", {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSubscription() {
  const res = await fetch("/api/user/subscription", {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ---------------------------------------------------------------------------
// OAuth consent
// ---------------------------------------------------------------------------

export interface AuthorizationDetails {
  client: { name: string; uri: string | null };
  redirectHost: string;
  scopes: string[];
  user: { email: string | null };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

/** What the pending authorization request is asking for (from the signed `request` token). */
export async function fetchAuthorizationDetails(request: string): Promise<AuthorizationDetails> {
  const res = await fetch(`/api/oauth/authorization?request=${encodeURIComponent(request)}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

/** Approve or deny; returns the client callback URL to navigate to. */
export async function submitOAuthConsent(params: {
  request: string;
  approve: boolean;
}): Promise<{ redirectUrl: string }> {
  const res = await fetch("/api/oauth/consent", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}
