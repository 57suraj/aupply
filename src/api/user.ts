/**
 * User API routes.
 *
 *   GET /api/user/me           — return current user info
 *   GET /api/user/subscription — return subscription status
 */

import { Router, type Request, type Response } from "express";
import { getSupabaseClient } from "../db/supabase.js";
import { getSubscription } from "../services/subscription.js";

export const userRouter = Router();

// ---------------------------------------------------------------------------
// Auth helper — resolves Supabase user from Bearer token
// ---------------------------------------------------------------------------

async function resolveUser(req: Request) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing authorization token."), {
      status: 401,
    });
  }

  const token = auth.slice(7);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw Object.assign(new Error("Invalid or expired session."), {
      status: 401,
    });
  }

  return data.user;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

userRouter.get("/me", async (req: Request, res: Response) => {
  try {
    const user = await resolveUser(req);
    res.json({
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Failed to fetch user.",
    });
  }
});

userRouter.get("/subscription", async (req: Request, res: Response) => {
  try {
    const user = await resolveUser(req);
    const sub = await getSubscription(user.id);

    if (!sub) {
      res.json({
        status: "none",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
      return;
    }

    res.json({
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({
      error:
        err instanceof Error ? err.message : "Failed to fetch subscription.",
    });
  }
});
