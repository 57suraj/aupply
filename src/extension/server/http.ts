/**
 * HTTP helpers for the /ext/v1 app: the error type and handler, the extension version gate,
 * the LinkedIn kill switch and the log prefix. Express 5 forwards a rejected async handler to
 * the error handler by itself, so routes need no wrapper.
 *
 * Error body (section 7.2): { error: { code, message, ...extra } }. Never logs tokens, poll
 * secrets, answer values, resume text or JD text; user ids are logged as an 8-character prefix.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { BASE_URL } from "../../config.js";
import { AppError } from "../../lib/errors.js";
import { VERSION_HEADER, type ErrorCode } from "../contract.js";

/** An error with one of the contract's codes and optional extra fields for the body. */
export class ExtError extends AppError {
  constructor(
    status: number,
    public readonly extCode: ErrorCode,
    message: string,
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(message, status, extCode);
    this.name = "ExtError";
  }
}

export const unauthorized = (message = "Sign in to Aupply again from the extension.") => new ExtError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed.") => new ExtError(403, "forbidden", message);
export const notFoundExt = (what: string) => new ExtError(404, "not_found", `${what} not found.`);
export const conflict = (message: string) => new ExtError(409, "conflict", message);

/** The user id as logs show it. */
export const uid8 = (userId: string | null | undefined) => (userId ? userId.slice(0, 8) : "-");

// ---------------------------------------------------------------------------
// Versions and the kill switch
// ---------------------------------------------------------------------------

const parts = (v: string) => v.split(".").map((n) => Number(n));
/** Semver-style compare of x.y.z strings: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

export const minVersion = () => (/^\d+\.\d+\.\d+$/.test(process.env.EXT_MIN_VERSION ?? "") ? process.env.EXT_MIN_VERSION! : "0.0.0");
export const DOWNLOAD_PATH = "/downloads/aupply-chrome.zip";
export const downloadUrl = () => `${BASE_URL}${DOWNLOAD_PATH}`;

/** Every device endpoint: the extension says its version; one below EXT_MIN_VERSION must update. */
export function versionGate(req: Request, _res: Response, next: NextFunction): void {
  const v = (req.get(VERSION_HEADER) ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(v) || compareVersions(v, minVersion()) < 0) {
    throw new ExtError(426, "upgrade_required", "This version of the Aupply extension is out of date. Download the new version and load it again.", {
      min_version: minVersion(),
      download_url: downloadUrl(),
    });
  }
  next();
}

/** EXT_LINKEDIN_ENABLED=false stops every extension's LinkedIn work at once. */
export const linkedinEnabled = () => (process.env.EXT_LINKEDIN_ENABLED ?? "true").trim().toLowerCase() !== "false";
export const DISABLED_MESSAGE = "Aupply has paused LinkedIn in the extension for now. Nothing will run until it is switched back on.";

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

const CODE_FOR: Record<number, ErrorCode> = {
  400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict",
  413: "invalid_request", 426: "upgrade_required", 429: "slow_down", 503: "ai_unavailable",
};

export function extErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  const send = (status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) =>
    res.status(status).json({ error: { code, message, ...extra } });
  if (err instanceof ZodError) {
    send(400, "invalid_request", "Invalid request.", { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return;
  }
  const type = (err as { type?: string })?.type;
  if (type === "entity.parse.failed") return void send(400, "invalid_request", "Malformed JSON body.");
  if (type === "entity.too.large") return void send(413, "invalid_request", "Request body too large.");
  if (err instanceof ExtError) {
    if (err.status >= 500) console.error(`[ext] ${req.method} ${req.path}`, err.message);
    send(err.status, err.extCode, err.message, err.extra);
    return;
  }
  if (err instanceof AppError && err.status < 500) {
    send(err.status, CODE_FOR[err.status] ?? "invalid_request", err.message);
    return;
  }
  const user = (res.locals.device as { userId?: string } | undefined)?.userId ?? (res.locals.user as { id?: string } | undefined)?.id;
  console.error(`[ext] ${req.method} ${req.path} user=${uid8(user)}`, err instanceof Error ? err.message : err);
  send(500, "internal", "Something went wrong on Aupply's side. Try again in a minute.");
}
