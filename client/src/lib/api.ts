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
