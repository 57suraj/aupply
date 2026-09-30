/**
 * Stripe API routes.
 *
 * Mounts on the Express app:
 *   POST /api/stripe/create-checkout-session   — create a Stripe Checkout session
 *   POST /api/stripe/billing-portal            — create a Stripe billing portal session
 *   POST /api/stripe/webhook                   — receive and process Stripe webhook events
 *
 * Security:
 *   - Checkout/portal routes require a valid Supabase session (Bearer token).
 *   - Webhook signature is verified using STRIPE_WEBHOOK_SECRET before any
 *     data is trusted. An unverified webhook is rejected with 400.
 *   - The frontend is NEVER the source of truth for subscription status.
 *     Status only changes via verified webhook events.
 */

import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import { getSupabaseClient } from "../db/supabase.js";
import { upsertSubscription } from "../services/subscription.js";

// ---------------------------------------------------------------------------
// Stripe client (lazy — only initialises when routes are called)
// ---------------------------------------------------------------------------

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  _stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia" });
  return _stripe;
}

// ---------------------------------------------------------------------------
// Auth helper — verify Supabase Bearer token and return user ID
// ---------------------------------------------------------------------------

async function resolveUserFromBearer(req: Request): Promise<string> {
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
    throw Object.assign(new Error("Invalid or expired session token."), {
      status: 401,
    });
  }

  return data.user.id;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const stripeRouter = Router();

/**
 * POST /api/stripe/create-checkout-session
 *
 * Creates a Stripe Checkout session for the $2/month subscription.
 * Requires: authenticated user (Supabase Bearer token).
 * Returns: { url } — the Stripe-hosted checkout URL.
 */
stripeRouter.post(
  "/create-checkout-session",
  async (req: Request, res: Response) => {
    try {
      const userId = await resolveUserFromBearer(req);
      const stripe = getStripe();

      const priceId = process.env.STRIPE_PRICE_ID;
      const baseUrl =
        process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

      if (!priceId) {
        res.status(500).json({ error: "STRIPE_PRICE_ID is not configured." });
        return;
      }

      // Check if user already has a Stripe customer ID
      const supabase = getSupabaseClient();
      const { data: existingSub } = await supabase
        .from("subscriptions")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();

      // Get user email for pre-filling checkout
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      const email = userData.user?.email;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/account?checkout=success`,
        cancel_url: `${baseUrl}/pricing`,
        // Use existing customer ID if available, otherwise create a new customer
        ...(existingSub?.stripe_customer_id
          ? { customer: existingSub.stripe_customer_id }
          : { customer_email: email }),
        // Store user ID so the webhook can map payment to a user
        client_reference_id: userId,
        subscription_data: {
          metadata: { aupply_user_id: userId },
        },
      });

      res.json({ url: session.url });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : "Checkout session failed.";
      res.status(status).json({ error: message });
    }
  }
);

/**
 * POST /api/stripe/billing-portal
 *
 * Creates a Stripe Customer Portal session so the user can manage their
 * subscription without us implementing billing UI.
 */
stripeRouter.post("/billing-portal", async (req: Request, res: Response) => {
  try {
    const userId = await resolveUserFromBearer(req);
    const stripe = getStripe();

    const supabase = getSupabaseClient();
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      res.status(404).json({ error: "No billing account found." });
      return;
    }

    const baseUrl =
      process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${baseUrl}/account`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : "Billing portal failed.";
    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/stripe/webhook
 *
 * Receives Stripe webhook events.
 * IMPORTANT: This route must receive the RAW request body (not JSON-parsed).
 * Mount it with express.raw() BEFORE app.use(express.json()).
 *
 * The webhook handler is the sole mechanism for updating subscription status.
 * It verifies the Stripe signature before processing any event.
 */
export async function stripeWebhookHandler(
  req: Request,
  res: Response
): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET is not set.");
    res.status(500).json({ error: "Webhook secret not configured." });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).json({ error: "Missing Stripe-Signature header." });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body as Buffer,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error("[stripe/webhook] Signature verification failed:", err);
    res.status(400).json({ error: "Webhook signature verification failed." });
    return;
  }

  // -------------------------------------------------------------------
  // Process verified events
  // -------------------------------------------------------------------
  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const userId =
          sub.metadata?.aupply_user_id ||
          (sub as unknown as { client_reference_id?: string })
            .client_reference_id;

        if (!userId) {
          console.warn(
            "[stripe/webhook] No aupply_user_id in subscription metadata:",
            sub.id
          );
          break;
        }

        const item = sub.items.data[0];
        // In Stripe API v22 (dahlia), current_period_end is derived from
        // billing_schedules or billing_cycle_anchor. We use cancel_at as
        // a proxy for period end, or fall back to billing_cycle_anchor + 30d.
        const periodEndTimestamp =
          sub.cancel_at ??
          (sub.billing_cycle_anchor + 30 * 24 * 60 * 60);
        await upsertSubscription({
          userId,
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: sub.id,
          stripePriceId: item?.price?.id ?? null,
          status: sub.status,
          currentPeriodEnd: new Date(periodEndTimestamp * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        });

        console.log(
          `[stripe/webhook] Subscription ${sub.id} → ${sub.status} for user ${userId}`
        );
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.aupply_user_id;
        if (!userId) break;

        await upsertSubscription({
          userId,
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: sub.id,
          stripePriceId: null,
          status: "canceled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        });
        console.log(`[stripe/webhook] Subscription canceled for user ${userId}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // In Stripe API v22, subscription is in parent.subscription_details
        const subId =
          (invoice.parent?.type === "subscription_details"
            ? (invoice.parent.subscription_details?.subscription as string | undefined)
            : undefined) ?? null;
        if (!subId) break;

        // Mark as past_due in DB
        const supabase = getSupabaseClient();
        await supabase
          .from("subscriptions")
          .update({ status: "past_due", updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", subId);

        console.log(`[stripe/webhook] Payment failed for subscription ${subId}`);
        break;
      }

      default:
        // Acknowledge but don't act on unhandled events
        break;
    }
  } catch (err) {
    console.error("[stripe/webhook] Handler error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
    return;
  }

  res.json({ received: true });
}
