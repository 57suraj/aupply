/** The side panel's view of everything (UiState), and the broadcast when it changes. */

import { MeResponse } from "../../../src/extension/contract";
import { BASE_URL, EXT_VERSION } from "../shared/env";
import type { UiState } from "../shared/messages";
import { call } from "./api";
import { local, session } from "./store";
import { debuggerGranted } from "./tab";

export async function refreshMe() {
  const me = await call("GET", "/me", undefined, MeResponse);
  await session.set("me", { at: Date.now(), me });
  return me;
}

export async function buildState(error: string | null = null): Promise<UiState> {
  const [auth, pairing, me, run, updateRequired, granted] = await Promise.all([
    local.get("auth"), session.get("pairing"), session.get("me"), session.get("run"), local.get("updateRequired"), debuggerGranted(),
  ]);
  return {
    connected: Boolean(auth),
    device: auth ? { id: auth.deviceId, name: auth.deviceName } : null,
    pairing: pairing ? { user_code: pairing.user_code, verify_url: pairing.verify_url, expires_at: pairing.expires_at } : null,
    me: auth ? me?.me ?? null : null,
    run: run ?? null,
    updateRequired: updateRequired ?? null,
    debuggerGranted: granted,
    version: EXT_VERSION,
    baseUrl: BASE_URL,
    error,
  };
}

export async function broadcast() {
  try {
    await chrome.runtime.sendMessage({ type: "state/changed", state: await buildState() });
  } catch {
    /* no side panel open */
  }
}

export function notify(message: string) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/128.png", title: "Aupply", message, priority: 1 }, () => void chrome.runtime.lastError);
}
