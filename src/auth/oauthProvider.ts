/**
 * OAuth 2.1 authorization server for the Claude MCP connector.
 *
 * Plugs into the MCP SDK's `mcpAuthRouter`, which serves the protocol endpoints
 * (/authorize, /token, /register, /revoke, /.well-known/*) and performs PKCE
 * verification. This provider supplies storage and policy:
 *
 *   Claude -> GET /authorize           authorize(): validate, then redirect to the
 *                                      SPA consent page with a signed request token
 *   user   -> /oauth/consent (SPA)     logs in with Supabase, approves
 *   SPA    -> POST /api/oauth/consent  consentRoutes.ts issues a single-use code
 *   Claude -> POST /token              exchangeAuthorizationCode(): creates a grant,
 *                                      returns access + refresh tokens
 *   Claude -> POST /mcp (Bearer)       verifyAccessToken(): JWT + grant not revoked
 *
 * Security invariants:
 *   - User identity comes only from the verified Supabase session at consent time.
 *   - Codes and refresh tokens are stored hashed; codes are single-use and a
 *     replayed code revokes the grant it minted.
 *   - Refresh tokens rotate on every use.
 *   - Revoking a grant (dashboard or /revoke) invalidates its access tokens at once.
 */

import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  BASE_URL,
  REFRESH_TOKEN_TTL_SECONDS,
  RESOURCE_URL,
  SCOPES,
} from "../config.js";
import {
  randomToken,
  sha256,
  signAccessToken,
  signAuthorizationRequest,
  verifyAccessTokenJwt,
} from "./tokens.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// ---------------------------------------------------------------------------
// Policy helpers (also used by consentRoutes.ts)
// ---------------------------------------------------------------------------

/**
 * RFC 8707 resource indicator. Clients may name the MCP endpoint or the bare
 * origin; both mean this server. Anything else is not ours to grant.
 */
export function normalizeResource(resource?: URL | string): string {
  if (!resource) return RESOURCE_URL;
  const value = String(resource).replace(/\/+$/, "");
  if (value === RESOURCE_URL || value === BASE_URL) return RESOURCE_URL;
  throw new InvalidTargetError(`Unknown resource: ${value}`);
}

/** Unknown scopes are dropped; an empty request gets the default scope set. */
export function normalizeScopes(requested?: string[]): string[] {
  const supported = new Set<string>(SCOPES);
  const granted = (requested ?? []).filter((s) => supported.has(s));
  return granted.length > 0 ? granted : [...SCOPES];
}

function assertAllowedRedirectUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new InvalidClientMetadataError(
    `redirect_uri must use https (or http on localhost): ${uri}`
  );
}

// ---------------------------------------------------------------------------
// Client store (dynamic client registration)
// ---------------------------------------------------------------------------

type ClientRow = {
  id: string;
  client_secret: string | null;
  client_secret_expires_at: number | null;
  client_id_issued_at: number;
  redirect_uris: string[];
  metadata: Json;
};

function rowToClient(row: ClientRow): OAuthClientInformationFull {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    ...(metadata as Partial<OAuthClientInformationFull>),
    client_id: row.id,
    client_secret: row.client_secret ?? undefined,
    client_secret_expires_at: row.client_secret_expires_at ?? undefined,
    client_id_issued_at: row.client_id_issued_at,
    redirect_uris: row.redirect_uris,
  } as OAuthClientInformationFull;
}

export const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const { data, error } = await getSupabaseClient()
      .from("oauth_clients")
      .select("id, client_secret, client_secret_expires_at, client_id_issued_at, redirect_uris, metadata")
      .eq("id", clientId)
      .maybeSingle();
    if (error) {
      console.error("[oauth] getClient failed:", error);
      return undefined;
    }
    return data ? rowToClient(data) : undefined;
  },

  async registerClient(client) {
    const full = client as OAuthClientInformationFull;
    if (!full.client_id || !full.client_id_issued_at) {
      throw new InvalidClientMetadataError("Client id generation is required.");
    }
    full.redirect_uris.forEach((uri) => assertAllowedRedirectUri(String(uri)));

    // Keep the secret out of the metadata copy; it lives in its own column.
    const { client_secret, ...publicInfo } = full;
    const { error } = await getSupabaseClient().from("oauth_clients").insert({
      id: full.client_id,
      client_secret: client_secret ?? null,
      client_secret_expires_at: full.client_secret_expires_at ?? null,
      client_id_issued_at: full.client_id_issued_at,
      client_name: full.client_name ?? null,
      redirect_uris: full.redirect_uris.map(String),
      token_endpoint_auth_method: full.token_endpoint_auth_method ?? "client_secret_post",
      metadata: publicInfo as unknown as Json,
    });
    if (error) {
      console.error("[oauth] registerClient failed:", error);
      throw new InvalidClientMetadataError("Client registration failed.");
    }
    return full;
  },
};

// ---------------------------------------------------------------------------
// Grants and token issuance
// ---------------------------------------------------------------------------

function refreshExpiry(): string {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
}

async function issueTokens(params: {
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  refreshToken: string;
}): Promise<OAuthTokens> {
  const accessToken = await signAccessToken(params);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: params.refreshToken,
    scope: params.scopes.join(" "),
  };
}

export async function revokeGrant(grantId: string, userId?: string): Promise<boolean> {
  let query = getSupabaseClient()
    .from("oauth_grants")
    .update({ revoked_at: new Date().toISOString(), refresh_token_hash: null })
    .eq("id", grantId)
    .is("revoked_at", null);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.select("id");
  if (error) {
    console.error("[oauth] revokeGrant failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const request = await signAuthorizationRequest({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: normalizeScopes(params.scopes),
      resource: normalizeResource(params.resource),
    });
    res.redirect(302, `${BASE_URL}/oauth/consent?request=${encodeURIComponent(request)}`);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const { data } = await getSupabaseClient()
      .from("oauth_authorization_codes")
      .select("client_id, code_challenge")
      .eq("code_hash", sha256(authorizationCode))
      .maybeSingle();
    if (!data || data.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code.");
    }
    return data.code_challenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const db = getSupabaseClient();
    const codeHash = sha256(authorizationCode);
    const now = new Date().toISOString();

    // Consume atomically: only one exchange can ever flip consumed_at.
    const { data: code } = await db
      .from("oauth_authorization_codes")
      .update({ consumed_at: now })
      .eq("code_hash", codeHash)
      .is("consumed_at", null)
      .gt("expires_at", now)
      .select("*")
      .maybeSingle();

    if (!code) {
      // Replay of a used code: revoke whatever it minted (OAuth 2.1 §4.1.3).
      const { data: used } = await db
        .from("oauth_authorization_codes")
        .select("grant_id, consumed_at")
        .eq("code_hash", codeHash)
        .maybeSingle();
      if (used?.consumed_at && used.grant_id) await revokeGrant(used.grant_id);
      throw new InvalidGrantError("Authorization code is invalid, expired or already used.");
    }
    if (code.client_id !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to another client.");
    }
    if (redirectUri !== undefined && redirectUri !== code.redirect_uri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (resource && normalizeResource(resource) !== (code.resource ?? RESOURCE_URL)) {
      throw new InvalidTargetError("resource does not match the authorization request.");
    }

    const refreshToken = randomToken();
    const { data: grant, error } = await db
      .from("oauth_grants")
      .insert({
        user_id: code.user_id,
        client_id: code.client_id,
        scopes: code.scopes,
        resource: code.resource,
        refresh_token_hash: sha256(refreshToken),
        refresh_token_expires_at: refreshExpiry(),
        last_used_at: now,
      })
      .select("id")
      .single();
    if (error || !grant) {
      console.error("[oauth] grant insert failed:", error);
      throw new InvalidGrantError("Could not create grant.");
    }

    await db.from("oauth_authorization_codes").update({ grant_id: grant.id }).eq("code_hash", codeHash);
    // Opportunistic cleanup of stale codes; failures are irrelevant.
    await db
      .from("oauth_authorization_codes")
      .delete()
      .lt("expires_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    return issueTokens({
      userId: code.user_id,
      clientId: code.client_id,
      grantId: grant.id,
      scopes: code.scopes,
      refreshToken,
    });
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const db = getSupabaseClient();
    const now = new Date().toISOString();
    const nextRefreshToken = randomToken();

    // Rotate atomically: the old token stops working the moment this succeeds.
    const { data: grant } = await db
      .from("oauth_grants")
      .update({
        refresh_token_hash: sha256(nextRefreshToken),
        refresh_token_expires_at: refreshExpiry(),
        last_used_at: now,
      })
      .eq("refresh_token_hash", sha256(refreshToken))
      .eq("client_id", client.client_id)
      .is("revoked_at", null)
      .gt("refresh_token_expires_at", now)
      .select("id, user_id, client_id, scopes, resource")
      .maybeSingle();

    if (!grant) throw new InvalidGrantError("Refresh token is invalid, expired or revoked.");
    if (resource && normalizeResource(resource) !== (grant.resource ?? RESOURCE_URL)) {
      throw new InvalidTargetError("resource does not match the grant.");
    }
    const narrowed = scopes?.length ? scopes : grant.scopes;
    if (!narrowed.every((s) => grant.scopes.includes(s))) {
      throw new InvalidScopeError("Requested scope exceeds the original grant.");
    }

    return issueTokens({
      userId: grant.user_id,
      clientId: grant.client_id,
      grantId: grant.id,
      scopes: narrowed,
      refreshToken: nextRefreshToken,
    });
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    // Local-only bypass for exercising tools without an OAuth dance.
    if (
      process.env.NODE_ENV === "development" &&
      token === "dev-token" &&
      process.env.DEV_USER_ID
    ) {
      return {
        token,
        clientId: "dev",
        scopes: [...SCOPES],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { userId: process.env.DEV_USER_ID },
      };
    }

    let claims;
    try {
      claims = await verifyAccessTokenJwt(token);
    } catch {
      throw new InvalidTokenError("Invalid or expired access token.");
    }

    const { data: grant } = await getSupabaseClient()
      .from("oauth_grants")
      .select("user_id, revoked_at")
      .eq("id", claims.grantId)
      .maybeSingle();
    if (!grant || grant.revoked_at || grant.user_id !== claims.userId) {
      throw new InvalidTokenError("Access token has been revoked.");
    }

    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: claims.expiresAt,
      resource: new URL(RESOURCE_URL),
      extra: { userId: claims.userId, grantId: claims.grantId },
    };
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    // RFC 7009: never reveal whether the token existed.
    const db = getSupabaseClient();
    if (request.token_type_hint !== "access_token") {
      const { data } = await db
        .from("oauth_grants")
        .update({ revoked_at: new Date().toISOString(), refresh_token_hash: null })
        .eq("refresh_token_hash", sha256(request.token))
        .eq("client_id", client.client_id)
        .is("revoked_at", null)
        .select("id");
      if (data?.length) return;
    }
    try {
      const claims = await verifyAccessTokenJwt(request.token);
      if (claims.clientId === client.client_id) await revokeGrant(claims.grantId);
    } catch {
      // Not a valid access token either; nothing to do.
    }
  },
};
