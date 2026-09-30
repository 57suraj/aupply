/**
 * Consent API used by the SPA page at /oauth/consent.
 *
 *   GET  /api/oauth/authorization?request=...  what is being asked, for display
 *   POST /api/oauth/consent { request, approve } -> { redirectUrl }
 *
 * `request` is the signed token minted by oauthProvider.authorize(), so the
 * client, redirect URI, PKCE challenge and scopes cannot be altered in the
 * browser. The user is whoever holds the Supabase session.
 */

import { Router } from "express";
import { z } from "zod";
import { getSupabaseClient } from "../db/supabase.js";
import { AppError } from "../lib/errors.js";
import { AUTH_CODE_TTL_SECONDS, ISSUER } from "../config.js";
import { requireUser, sessionUser } from "./supabaseUser.js";
import { clientsStore } from "./oauthProvider.js";
import { randomToken, sha256, verifyAuthorizationRequest, type AuthorizationRequest } from "./tokens.js";

export const consentRouter = Router();
consentRouter.use(requireUser);

async function loadRequest(token: unknown): Promise<{
  request: AuthorizationRequest;
  clientName: string;
  clientUri: string | null;
}> {
  if (typeof token !== "string" || !token) {
    throw new AppError("Missing authorization request.", 400);
  }
  let request: AuthorizationRequest;
  try {
    request = await verifyAuthorizationRequest(token);
  } catch {
    throw new AppError("This authorization request is invalid or has expired. Start the connection again from Claude.", 400);
  }
  const client = await clientsStore.getClient(request.clientId);
  if (!client || !client.redirect_uris.map(String).includes(request.redirectUri)) {
    throw new AppError("The requesting application is no longer registered.", 400);
  }
  return {
    request,
    clientName: client.client_name || "Unnamed application",
    clientUri: client.client_uri ? String(client.client_uri) : null,
  };
}

function callback(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

consentRouter.get("/authorization", async (req, res) => {
  const { request, clientName, clientUri } = await loadRequest(req.query.request);
  res.json({
    client: { name: clientName, uri: clientUri },
    redirectHost: new URL(request.redirectUri).host,
    scopes: request.scopes,
    user: { email: sessionUser(res).email },
  });
});

const ConsentBody = z.object({ request: z.string().min(1), approve: z.boolean() });

consentRouter.post("/consent", async (req, res) => {
  const body = ConsentBody.parse(req.body);
  const { request } = await loadRequest(body.request);

  if (!body.approve) {
    res.json({
      redirectUrl: callback(request.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the request.",
        state: request.state,
        iss: ISSUER,
      }),
    });
    return;
  }

  const code = randomToken();
  const { error } = await getSupabaseClient()
    .from("oauth_authorization_codes")
    .insert({
      code_hash: sha256(code),
      client_id: request.clientId,
      user_id: sessionUser(res).id,
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      scopes: request.scopes,
      resource: request.resource,
      expires_at: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString(),
    });
  if (error) {
    console.error("[oauth] code insert failed:", error);
    throw new AppError("Could not complete authorization.", 500);
  }

  res.json({
    redirectUrl: callback(request.redirectUri, { code, state: request.state, iss: ISSUER }),
  });
});
