/**
 * getAuthenticatedUser — single point of truth for resolving caller identity.
 *
 * Extracts the Bearer token from the Authorization header, verifies it as a
 * signed JWT issued by our OAuth server, and returns the AuthenticatedUser.
 *
 * The Supabase user ID in the JWT `sub` claim is the authoritative user identity.
 * MCP tools receive it via the getUser() thunk — they never inspect HTTP headers
 * or trust any user ID from the MCP request payload.
 *
 * Auth chain:
 *   Bearer token (from Claude)
 *     → verifyAccessToken() (JWT signature + expiry check)
 *       → AuthenticatedUser { id = sub claim }
 *         → DB queries scoped to user.id
 */

import type { Request } from "express";
import { verifyAccessToken } from "./oauth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthenticatedUser {
  /** Supabase user ID — sourced exclusively from the verified JWT sub claim. */
  id: string;
  oauthSubject: string;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim() || null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated user from the incoming request's Bearer token.
 *
 * Throws AuthenticationError if:
 *   - No Bearer token is present
 *   - The JWT signature is invalid
 *   - The JWT is expired
 *   - The JWT is missing the sub claim
 */
export async function getAuthenticatedUser(
  req: Request
): Promise<AuthenticatedUser> {
  const token = extractBearerToken(req);

  if (!token) {
    throw new AuthenticationError(
      "Missing Authorization header. Expected: Bearer <token>",
      401
    );
  }

  try {
    const { userId } = await verifyAccessToken(token);
    return { id: userId, oauthSubject: userId };
  } catch (err) {
    // In development, allow a special bypass token for local testing
    if (process.env.NODE_ENV === "development" && token === "dev-token") {
      console.warn(
        "[auth] Using dev bypass token. " +
          "This is NOT secure and must be disabled before production."
      );
      return {
        id: "dev-placeholder-user-id",
        oauthSubject: "dev-placeholder-user-id",
      };
    }

    throw new AuthenticationError(
      `Invalid or expired access token: ${err instanceof Error ? err.message : "unknown error"}`,
      401
    );
  }
}
