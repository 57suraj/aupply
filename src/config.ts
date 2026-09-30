/**
 * Runtime configuration derived from the environment.
 *
 * BASE_URL is the public origin of the whole app (SPA + API + MCP). It is the
 * OAuth issuer, and RESOURCE_URL (the MCP endpoint) is the token audience.
 * Locally MCP_BASE_URL points at the Vite dev server, which proxies backend paths.
 */

export const BASE_URL = (
  process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`
).replace(/\/+$/, "");

/** OAuth issuer exactly as the SDK advertises it in metadata (URL.href adds a trailing slash). */
export const ISSUER = new URL(BASE_URL).href;

export const MCP_PATH = "/mcp";
export const RESOURCE_URL = `${BASE_URL}${MCP_PATH}`;

/** OAuth scopes. A single scope today; split it when read-only access is needed. */
export const SCOPES = ["mcp"] as const;

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days, sliding
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
export const AUTHZ_REQUEST_TTL_SECONDS = 15 * 60;

export function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set to a string of 32+ characters in production.");
    }
    // Dev fallback, only when NODE_ENV !== 'production'
    return new TextEncoder().encode("dev-jwt-secret-replace-in-production-!!!!");
  }
  return new TextEncoder().encode(secret);
}
