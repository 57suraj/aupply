/**
 * Small helpers shared by the /api routers.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError, z } from "zod";
import { AppError } from "../lib/errors.js";
import { sessionUser } from "../auth/supabaseUser.js";

export const userId = (res: Response) => sessionUser(res).id;

/** Route param `:id` as a UUID (400 otherwise). */
export const idParam = (req: Request, name = "id") => z.string().uuid().parse(req.params[name]);

/** Comma-separated query value -> string[] (or undefined). */
export function listParam(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

export function intParam(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

export function boolParam(value: unknown): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

export const strParam = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Error handler for /api: validation -> 400, AppError -> its status, rest -> 500. */
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Invalid request.",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof AppError) {
    if (err.status >= 500) console.error("[api]", err);
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body." });
    return;
  }
  console.error("[api] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
}
