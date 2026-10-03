/**
 * Calls to the extension channel's website endpoints (/ext/v1/web/*) with the user's Supabase
 * session, like ../lib/api.ts does for /api (that file is not changed). Errors carry the server's
 * code: the extension API answers { error: { code, message } }, the session check { error: "..." }.
 */

import { supabase } from "../lib/supabase";
import type { WebDevice, WebExtensionInfo, WebPairDecisionResponse, WebPairInfo } from "../../../src/extension/contract";

export class ExtApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/ext/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    throw new ExtApiError(res.status, typeof e === "object" && e ? e.code : `http_${res.status}`, typeof e === "object" && e ? e.message : e || `Request failed (${res.status}).`);
  }
  return json as T;
}

export const extensionInfo = () => req<WebExtensionInfo>("GET", "/web/extension");
export const listDevices = () => req<WebDevice[]>("GET", "/web/devices");
export const revokeDevice = (id: string) => req<void>("DELETE", `/web/devices/${encodeURIComponent(id)}`);
export const pairInfo = (code: string) => req<WebPairInfo>("GET", `/web/pair/${encodeURIComponent(code)}`);
export const decidePairing = (code: string, approve: boolean) => req<WebPairDecisionResponse>("POST", `/web/pair/${encodeURIComponent(code)}`, { approve });
