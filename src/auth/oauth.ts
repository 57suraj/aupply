/**
 * OAuth 2.0 Authorization Server module.
 *
 * This server acts as a standard OAuth 2.0 Authorization Server so Claude
 * can connect to the MCP using the "Authorization Code" grant type.
 *
 * Flow:
 *   Claude → GET /oauth/authorize?...
 *     → redirect to /login?oauth_return=/oauth/consent?...
 *     → user logs in via Supabase Auth
 *     → redirect to /oauth/consent?...
 *     → user clicks "Authorize"
 *     → POST /api/oauth/consent  (frontend calls this with Supabase token)
 *       → backend verifies Supabase token
 *       → issues auth code JWT (5-minute TTL)
 *       → returns redirect URL to Claude's callback
 *   Claude → POST /oauth/token (exchanges code for access token)
 *     → backend verifies code JWT
 *     → issues access token JWT (90-day TTL)
 *     → Claude uses access token as Bearer on /mcp requests
 *   MCP → verifies access token → gets Supabase user ID → queries DB
 *
 * Tokens are signed JWTs using JWT_SECRET. No database table is needed
 * for auth codes because they are short-lived and self-contained.
 *
 * Security invariants:
 *   - User identity always comes from the Supabase-verified session.
 *   - The access token contains the Supabase user ID as `sub`.
 *   - MCP tools receive this user ID and scope all DB queries to it.
 *   - Claude never supplies a user ID directly — it is always from the token.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getSupabaseClient } from "../db/supabase.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
const MCP_BASE_URL =
  process.env.MCP_BASE_URL || "http://localhost:3000";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set to a string of 32+ characters in production.");
    }
    // Dev fallback — only active when NODE_ENV !== 'production'
    return new TextEncoder().encode("dev-jwt-secret-replace-in-production-!!!!");
  }
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

interface AuthCodePayload extends JWTPayload {
  type: "auth_code";
  userId: string;
  clientId: string;
  redirectUri: string;
}

interface AccessTokenPayload extends JWTPayload {
  type: "access_token";
}

/**
 * Create a short-lived authorization code JWT (5 minutes).
 */
async function createAuthCode(params: {
  userId: string;
  clientId: string;
  redirectUri: string;
}): Promise<string> {
  const secret = getJwtSecret();
  return new SignJWT({
    type: "auth_code",
    userId: params.userId,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
  } satisfies Omit<AuthCodePayload, keyof JWTPayload>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(MCP_BASE_URL)
    .sign(secret);
}

/**
 * Create a long-lived access token JWT (90 days).
 * The `sub` claim is the Supabase user ID.
 */
async function createAccessToken(userId: string): Promise<string> {
  const secret = getJwtSecret();
  return new SignJWT({ type: "access_token" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("90d")
    .setIssuer(MCP_BASE_URL)
    .sign(secret);
}

/**
 * Verify an auth code JWT and return its payload.
 */
async function verifyAuthCode(code: string): Promise<AuthCodePayload> {
  const secret = getJwtSecret();
  const { payload } = await jwtVerify(code, secret, {
    issuer: MCP_BASE_URL,
  });
  if ((payload as AuthCodePayload).type !== "auth_code") {
    throw new Error("Invalid token type.");
  }
  return payload as AuthCodePayload;
}

/**
 * Verify an access token JWT and return the Supabase user ID (sub claim).
 */
export async function verifyAccessToken(
  token: string
): Promise<{ userId: string }> {
  const secret = getJwtSecret();
  const { payload } = await jwtVerify(token, secret, {
    issuer: MCP_BASE_URL,
  });
  if ((payload as AccessTokenPayload).type !== "access_token") {
    throw new Error("Invalid token type.");
  }
  if (!payload.sub) {
    throw new Error("Token missing sub claim.");
  }
  return { userId: payload.sub };
}

// ---------------------------------------------------------------------------
// Route handlers — mounted in server.ts
// ---------------------------------------------------------------------------

export const oauthRouter = Router();

/**
 * GET /oauth/authorize
 *
 * Standard OAuth authorization endpoint.
 * Redirects the user's browser to the consent page (frontend).
 * If not logged in, the consent page will redirect to /login.
 */
export function handleAuthorize(req: Request, res: Response): void {
  const { response_type, client_id, redirect_uri, state, scope } = req.query as Record<
    string,
    string
  >;

  if (response_type !== "code") {
    res.status(400).json({
      error: "unsupported_response_type",
      description: 'Only response_type=code is supported.',
    });
    return;
  }

  if (!client_id || !redirect_uri) {
    res.status(400).json({
      error: "invalid_request",
      description: "client_id and redirect_uri are required.",
    });
    return;
  }

  // Validate client_id
  if (OAUTH_CLIENT_ID && client_id !== OAUTH_CLIENT_ID) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  // Redirect the browser to the frontend consent page
  const consentParams = new URLSearchParams({
    client_id,
    redirect_uri,
    ...(state ? { state } : {}),
    ...(scope ? { scope } : {}),
  });

  res.redirect(`${MCP_BASE_URL}/oauth/consent?${consentParams.toString()}`);
}

/**
 * POST /api/oauth/consent
 *
 * Called by the frontend consent page after the user clicks "Authorize".
 * Verifies the user's Supabase session token and issues an authorization code.
 *
 * Body: { supabaseAccessToken, clientId, redirectUri, state, scope? }
 * Returns: { redirectUrl } — the callback URL including the code.
 */
oauthRouter.post("/consent", async (req: Request, res: Response) => {
  const { supabaseAccessToken, clientId, redirectUri, state } = req.body as {
    supabaseAccessToken: string;
    clientId: string;
    redirectUri: string;
    state?: string;
  };

  if (!supabaseAccessToken || !clientId || !redirectUri) {
    res.status(400).json({ error: "Missing required fields." });
    return;
  }

  // Validate client
  if (OAUTH_CLIENT_ID && clientId !== OAUTH_CLIENT_ID) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  // Verify the Supabase session token
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(supabaseAccessToken);

  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired Supabase session." });
    return;
  }

  const userId = data.user.id;

  // Issue the auth code
  const code = await createAuthCode({ userId, clientId, redirectUri });

  // Build the redirect URL for Claude's callback
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  res.json({ redirectUrl: callbackUrl.toString() });
});

/**
 * POST /oauth/token
 *
 * Standard OAuth token endpoint.
 * Claude calls this to exchange the authorization code for an access token.
 *
 * Body: grant_type=authorization_code&code=...&client_id=...&client_secret=...&redirect_uri=...
 * Returns: { access_token, token_type, expires_in }
 */
export async function handleToken(req: Request, res: Response): Promise<void> {
  const { grant_type, code, client_id, client_secret, redirect_uri } =
    req.body as Record<string, string>;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!code || !client_id || !redirect_uri) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  // Validate client credentials
  if (
    (OAUTH_CLIENT_ID && client_id !== OAUTH_CLIENT_ID) ||
    (OAUTH_CLIENT_SECRET && client_secret !== OAUTH_CLIENT_SECRET)
  ) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  // Verify and decode the auth code
  let payload: AuthCodePayload;
  try {
    payload = await verifyAuthCode(code);
  } catch {
    res.status(400).json({ error: "invalid_grant", description: "Authorization code is invalid or expired." });
    return;
  }

  // Validate that redirect_uri matches what was used to create the code
  if (payload.redirectUri !== redirect_uri) {
    res.status(400).json({ error: "invalid_grant", description: "redirect_uri mismatch." });
    return;
  }

  // Issue the access token
  const accessToken = await createAccessToken(payload.userId);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 90 * 24 * 60 * 60, // 90 days in seconds
  });
}

/**
 * GET /oauth/callback
 * Placeholder — the actual callback is Claude's redirect_uri, not ours.
 */
export function handleCallback(_req: Request, res: Response): void {
  res.status(200).send("OAuth callback received. This endpoint is handled by the OAuth client.");
}
