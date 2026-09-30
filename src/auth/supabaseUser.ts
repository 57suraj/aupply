/**
 * requireUser: authenticates browser requests to /api/* with the user's
 * Supabase session token (Authorization: Bearer <access_token>).
 *
 * getClaims() verifies the JWT locally against the project's published signing
 * keys (ES256), so no round trip to Supabase Auth per request. A session
 * signed out elsewhere stays valid until its access token expires (~1h).
 */

import type { NextFunction, Request, Response } from "express";
import { getSupabaseClient } from "../db/supabase.js";

export interface SessionUser {
  id: string;
  email: string | null;
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Missing authorization token." });
    return;
  }

  const { data, error } = await getSupabaseClient().auth.getClaims(token);
  const claims = data?.claims;
  if (error || !claims?.sub || claims.role !== "authenticated") {
    res.status(401).json({ error: "Invalid or expired session." });
    return;
  }

  res.locals.user = {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
  } satisfies SessionUser;
  next();
}

/** The authenticated user for a request that passed requireUser. */
export function sessionUser(res: Response): SessionUser {
  const user = res.locals.user as SessionUser | undefined;
  if (!user) throw new Error("requireUser middleware did not run.");
  return user;
}
