/**
 * Pairing and sign-out (sections 7.3, 11.4). The extension starts a pairing, opens the website's
 * approval page and shows the code; the side panel asks for a poll every 3 seconds (a service
 * worker can be stopped between polls, and the user is looking at the side panel while pairing).
 * The poll secret stays in session storage and is never shown.
 */

import { OkResponse, PairPollResponse, PairStartResponse } from "../../../src/extension/contract";
import { EXT_VERSION } from "../shared/env";
import { call, open } from "./api";
import { log } from "./log";
import { local, session } from "./store";

async function defaultName() {
  const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  let platform = ua?.platform || "";
  if (!platform) {
    try {
      platform = (await chrome.runtime.getPlatformInfo()).os;
    } catch {
      platform = "";
    }
  }
  const pretty: Record<string, string> = { mac: "macOS", win: "Windows", linux: "Linux", cros: "ChromeOS", android: "Android" };
  return `Chrome on ${pretty[platform] ?? platform ?? "this computer"}`.slice(0, 60);
}

export async function startPairing(deviceName?: string) {
  const name = (deviceName?.trim() || (await defaultName())).slice(0, 60);
  const p = await open("POST", "/pair/start", { device_name: name, ext_version: EXT_VERSION }, PairStartResponse);
  await session.set("pairing", { pair_id: p.pair_id, poll_secret: p.poll_secret, user_code: p.user_code, verify_url: p.verify_url, expires_at: p.expires_at });
  await chrome.tabs.create({ url: p.verify_url, active: true });
  log("pair", "started");
  return { user_code: p.user_code, verify_url: p.verify_url, expires_at: p.expires_at };
}

/** One poll. "approved" stores the credentials; "denied" and "expired" end the pairing. */
export async function pollPairing(): Promise<"pending" | "approved" | "denied" | "expired" | "none"> {
  const p = await session.get("pairing");
  if (!p) return "none";
  const r = await open("POST", "/pair/poll", { pair_id: p.pair_id, poll_secret: p.poll_secret }, PairPollResponse);
  if (r.status === "pending") return "pending";
  await session.remove("pairing");
  if (r.status === "approved") {
    await local.set("auth", { deviceId: r.device.id, deviceName: r.device.name, refreshToken: r.tokens.refresh_token });
    await session.set("access", { token: r.tokens.access_token, expiresAt: r.tokens.access_expires_at });
    await local.remove("updateRequired");
    log("pair", "approved", r.device.id.slice(0, 8));
  } else log("pair", r.status);
  return r.status;
}

export const cancelPairing = () => session.remove("pairing");

/** Forget this device's credentials (after a revoke, or a sign out). */
export async function forget() {
  await local.remove("auth");
  await session.remove("access");
  await session.remove("me");
}

/** Sign out: revoke this device on the server (best effort), then forget it. */
export async function signOut() {
  try {
    await call("POST", "/device/signout", {}, OkResponse);
  } catch {
    /* already revoked or offline: forget it anyway */
  }
  await forget();
  log("auth", "signed out");
}
