/**
 * Token primitives for the OAuth server.
 *
 * - Access tokens: HS256 JWTs (typ at+jwt), audience = the MCP resource URL,
 *   `sub` = Supabase user id, `gid` = the oauth_grants row they belong to.
 * - Refresh tokens and authorization codes: opaque random strings, stored as
 *   SHA-256 hashes only.
 * - Authorization requests: short-lived signed JWTs that carry the validated
 *   /authorize parameters to the consent page and back, so nothing the browser
 *   can edit is trusted.
 */

import crypto from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHZ_REQUEST_TTL_SECONDS,
  BASE_URL,
  RESOURCE_URL,
  getJwtSecret,
} from "../config.js";

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export interface AccessTokenClaims {
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  expiresAt: number;
}

export async function signAccessToken(params: {
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
}): Promise<string> {
  return new SignJWT({
    client_id: params.clientId,
    gid: params.grantId,
    scope: params.scopes.join(" "),
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(BASE_URL)
    .setAudience(RESOURCE_URL)
    .setSubject(params.userId)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

/** Verifies signature, issuer, audience, type and expiry. Throws on any failure. */
export async function verifyAccessTokenJwt(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, getJwtSecret(), {
    issuer: BASE_URL,
    audience: RESOURCE_URL,
    typ: "at+jwt",
    algorithms: ["HS256"],
  });
  const { sub, client_id, gid, scope, exp } = payload as JWTPayload & {
    client_id?: string;
    gid?: string;
    scope?: string;
  };
  if (!sub || !client_id || !gid || !exp) throw new Error("Malformed access token.");
  return {
    userId: sub,
    clientId: client_id,
    grantId: gid,
    scopes: scope ? scope.split(" ") : [],
    expiresAt: exp,
  };
}

// ---------------------------------------------------------------------------
// Authorization requests (/authorize -> consent page -> /api/oauth/consent)
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
}

export async function signAuthorizationRequest(req: AuthorizationRequest): Promise<string> {
  return new SignJWT({ ...req })
    .setProtectedHeader({ alg: "HS256", typ: "authz-request+jwt" })
    .setIssuer(BASE_URL)
    .setIssuedAt()
    .setExpirationTime(`${AUTHZ_REQUEST_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifyAuthorizationRequest(token: string): Promise<AuthorizationRequest> {
  const { payload } = await jwtVerify(token, getJwtSecret(), {
    issuer: BASE_URL,
    typ: "authz-request+jwt",
    algorithms: ["HS256"],
  });
  const p = payload as JWTPayload & Partial<AuthorizationRequest>;
  if (!p.clientId || !p.redirectUri || !p.codeChallenge || !p.resource || !Array.isArray(p.scopes)) {
    throw new Error("Malformed authorization request.");
  }
  return {
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    state: p.state,
    scopes: p.scopes,
    resource: p.resource,
  };
}
