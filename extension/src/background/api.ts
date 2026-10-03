/**
 * The /ext/v1 client (section 11.4). Bearer device token, the extension version header, zod
 * validation of every answer. A 401 token_expired refreshes once (one refresh shared by every
 * caller) and retries; a revoked device clears the credentials and stops the run; a 426 stores
 * "update required"; a 429 slow_down waits as told. Long requests keep the service worker awake.
 */

import type { ZodType, ZodTypeDef } from "zod";
import { RefreshResponse } from "../../../src/extension/contract";
import { API, EXT_VERSION } from "../shared/env";
import { log } from "./log";
import { local, session } from "./store";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

/** Called when the device's credentials are gone (revoked, signed out elsewhere). */
let onSignedOut: (why: string) => Promise<void> = async () => undefined;
export const setSignedOutHandler = (f: (why: string) => Promise<void>) => (onSignedOut = f);
/** Called on 426: the run stops and the side panel shows "Update required". */
let onUpdateRequired: () => Promise<void> = async () => undefined;
export const setUpdateRequiredHandler = (f: () => Promise<void>) => (onUpdateRequired = f);

/** Extension API calls reset the service worker's idle timer; one every 15s while a request runs. */
async function keepAwake<T>(p: Promise<T>): Promise<T> {
  const t = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => undefined), 15_000);
  try {
    return await p;
  } finally {
    clearInterval(t);
  }
}

async function raw(method: string, path: string, body: unknown, token: string | null) {
  const headers: Record<string, string> = { "X-Aupply-Ext-Version": EXT_VERSION };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await keepAwake(fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  } catch {
    throw new ApiError(0, "network", "Aupply could not be reached. Check the connection.");
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

const errOf = (status: number, json: any) =>
  new ApiError(status, json?.error?.code ?? (typeof json?.error === "string" ? "error" : "http_" + status), json?.error?.message ?? (typeof json?.error === "string" ? json.error : `HTTP ${status}`), json);

let refreshing: Promise<string> | null = null;

/** One refresh at a time for every caller. A 409 means another context rotated first: read the
    newest token from storage and try once more. */
export function refreshAccess(): Promise<string> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const auth = await local.get("auth");
        if (!auth) throw new ApiError(401, "unauthorized", "Not connected.");
        const r = await raw("POST", "/token/refresh", { refresh_token: auth.refreshToken }, null);
        if (r.status === 200) {
          const t = RefreshResponse.parse(r.json);
          await local.set("auth", { ...auth, refreshToken: t.refresh_token });
          await session.set("access", { token: t.access_token, expiresAt: t.access_expires_at });
          return t.access_token;
        }
        if (r.status === 409 && attempt === 0) continue;
        if (r.status === 426) {
          await local.set("updateRequired", { min_version: r.json?.error?.min_version ?? "", download_url: r.json?.error?.download_url ?? "" });
          await onUpdateRequired();
        }
        throw errOf(r.status, r.json);
      }
      throw new ApiError(409, "conflict", "Token rotation raced twice.");
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function accessToken(): Promise<string> {
  const a = await session.get("access");
  if (a && Date.parse(a.expiresAt) - Date.now() > 60_000) return a.token;
  return refreshAccess();
}

/** An authenticated device call, its answer validated with `schema`. */
export async function call<T>(method: string, path: string, body: unknown, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let token: string;
    try {
      token = await accessToken();
    } catch (err) {
      if (err instanceof ApiError && (err.code === "device_revoked" || err.code === "unauthorized")) {
        await onSignedOut(err.code);
      }
      throw err;
    }
    const r = await raw(method, path, body, token);
    if (r.status >= 200 && r.status < 300) {
      const parsed = schema.safeParse(r.json);
      if (!parsed.success) {
        log("api", path, "answer failed its schema");
        throw new ApiError(r.status, "bad_answer", "Aupply answered in a way this version of the extension does not understand. Update the extension.");
      }
      return parsed.data;
    }
    const code = r.json?.error?.code;
    if (r.status === 401 && code === "token_expired" && attempt === 0) {
      await session.remove("access");
      continue;
    }
    if (r.status === 401 && (code === "device_revoked" || code === "unauthorized")) {
      log("api", path, r.status, code);
      await onSignedOut(code);
      throw errOf(r.status, r.json);
    }
    if (r.status === 426) {
      await local.set("updateRequired", { min_version: r.json?.error?.min_version ?? "", download_url: r.json?.error?.download_url ?? "" });
      await onUpdateRequired();
      throw errOf(r.status, r.json);
    }
    if (r.status === 429 && code === "slow_down" && attempt < 2) {
      await new Promise((res) => setTimeout(res, Math.min(30, Number(r.json?.error?.retry_after_s) || 3) * 1000));
      continue;
    }
    log("api", method, path, r.status, code ?? "");
    throw errOf(r.status, r.json);
  }
  throw new ApiError(0, "retries", "Too many retries.");
}

/** An unauthenticated call (pairing). */
export async function open<T>(method: string, path: string, body: unknown, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const r = await raw(method, path, body, null);
  if (r.status >= 200 && r.status < 300) return schema.parse(r.json);
  throw errOf(r.status, r.json);
}
