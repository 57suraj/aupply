/**
 * Device credentials for the extension channel (decision E3).
 *
 * - Access token: a 1-hour HS256 JWT signed with EXT_JWT_SECRET (never JWT_SECRET, so MCP
 *   tokens and device tokens can never stand in for each other), audience `${BASE_URL}/ext`,
 *   `sub` = user id, `did` = the ext_devices row.
 * - Refresh token: 32 random bytes prefixed `aext_`, stored only as a SHA-256 hash, rotated on
 *   every use with a 90-day sliding expiry.
 */

import crypto from "node:crypto";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import { BASE_URL, ISSUER } from "../../config.js";
import { ExtError, unauthorized } from "../server/http.js";

export const EXT_AUDIENCE = `${BASE_URL}/ext`;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_MS = 90 * 24 * 3600_000;

/** Mirrors getJwtSecret in src/config.ts (not imported: the channels share no secret). */
function secret(): Uint8Array {
  const s = process.env.EXT_JWT_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("EXT_JWT_SECRET must be set to a string of 32+ characters in production.");
    }
    // Dev fallback, only when NODE_ENV !== 'production'. Differs from the MCP's on purpose.
    return new TextEncoder().encode("dev-ext-jwt-secret-replace-in-production!");
  }
  return new TextEncoder().encode(s);
}

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const newRefreshToken = () => `aext_${randomSecret(32)}`;

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export async function signDeviceAccess(userId: string, deviceId: string) {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  const token = await new SignJWT({ did: deviceId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(EXT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret());
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Verifies signature, issuer, audience and expiry; an expired token is `token_expired`. */
export async function verifyDeviceAccess(token: string): Promise<{ userId: string; deviceId: string }> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: EXT_AUDIENCE, algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.did !== "string") throw unauthorized();
    return { userId: payload.sub, deviceId: payload.did };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new ExtError(401, "token_expired", "Access token expired.");
    if (err instanceof ExtError) throw err;
    throw unauthorized();
  }
}

/** Issue a fresh access token and a refresh token for a device; the caller stores the hash. */
export async function issueTokens(userId: string, deviceId: string) {
  const access = await signDeviceAccess(userId, deviceId);
  const refresh = newRefreshToken();
  return {
    tokens: { access_token: access.token, access_expires_at: access.expiresAt, refresh_token: refresh },
    refreshHash: sha256(refresh),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  };
}
