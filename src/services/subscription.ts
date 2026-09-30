/**
 * Subscription service — server-side, authoritative.
 *
 * The ONLY source of truth for whether a user has an active subscription
 * is the `subscriptions` table in Supabase (populated by Stripe webhooks).
 *
 * Never trust:
 *   - Frontend subscription flags
 *   - Query parameters
 *   - Client-supplied payloads
 *   - localStorage or cookies
 */

import { getSupabaseClient } from "../db/supabase.js";

export interface SubscriptionRecord {
  id: string;
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
}

export class SubscriptionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 402
  ) {
    super(message);
    this.name = "SubscriptionError";
  }
}

/**
 * Look up a user's subscription record.
 * Returns null if no subscription exists.
 */
export async function getSubscription(
  userId: string
): Promise<SubscriptionRecord | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[subscription] Error fetching subscription:", error);
    throw new Error("Failed to fetch subscription status.");
  }

  return data as SubscriptionRecord | null;
}

/**
 * Check whether a user has an active subscription.
 *
 * An active subscription satisfies ALL of:
 *   1. status = 'active' (or 'trialing')
 *   2. current_period_end is in the future (or null — relies on status alone)
 *
 * This check is purely database-driven — the Stripe webhook handler is
 * responsible for keeping the `subscriptions` table up to date.
 */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const sub = await getSubscription(userId);
  if (!sub) return false;

  const isActiveStatus =
    sub.status === "active" || sub.status === "trialing";

  if (!isActiveStatus) return false;

  if (sub.current_period_end) {
    const periodEnd = new Date(sub.current_period_end);
    if (periodEnd < new Date()) return false;
  }

  return true;
}

/**
 * requireActiveSubscription — call at the top of any gated server handler.
 *
 * Throws SubscriptionError (402) if the user does not have an active subscription.
 *
 * Usage pattern:
 *   const user = await getAuthenticatedUser(req);
 *   await requireActiveSubscription(user.id);   ← throws if not subscribed
 *   // ... rest of handler
 */
export async function requireActiveSubscription(userId: string): Promise<void> {
  const active = await hasActiveSubscription(userId);
  if (!active) {
    throw new SubscriptionError(
      "An active Aupply subscription is required to use the MCP tools. " +
        "Subscribe at https://aupply.app/pricing"
    );
  }
}

/**
 * Upsert a subscription record from a Stripe webhook event.
 * Called exclusively by the Stripe webhook handler.
 */
export async function upsertSubscription(data: {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("subscriptions").upsert(
    {
      user_id: data.userId,
      stripe_customer_id: data.stripeCustomerId,
      stripe_subscription_id: data.stripeSubscriptionId,
      stripe_price_id: data.stripePriceId,
      status: data.status,
      current_period_end: data.currentPeriodEnd?.toISOString() ?? null,
      cancel_at_period_end: data.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "stripe_subscription_id",
    }
  );

  if (error) {
    console.error("[subscription] Failed to upsert subscription:", error);
    throw new Error("Failed to update subscription record.");
  }
}
