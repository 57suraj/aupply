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

export async function submitOAuthConsent(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): Promise<{ redirectUrl: string }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");

  const res = await fetch("/api/oauth/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, supabaseAccessToken: token }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
