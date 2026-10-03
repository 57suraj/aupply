/**
 * Typed chrome.storage wrappers (section 11.3).
 *   local   (survives restarts): auth (device id and name, refresh token), settings, the log,
 *           updateRequired
 *   session (cleared when the browser closes; not visible to content scripts): the access token,
 *           the run state, the worker tab, a pairing in progress, the cached /me
 * The content script never reads storage. setAccessLevel is never called.
 */

import type { MeResponse, PostedWithin } from "../../../src/extension/contract";
import type { RunState } from "../shared/messages";

export interface Auth { deviceId: string; deviceName: string; refreshToken: string }
export interface Access { token: string; expiresAt: string }
export interface Pairing { pair_id: string; poll_secret: string; user_code: string; verify_url: string; expires_at: string }
export interface Settings { postedWithin?: PostedWithin }
export interface UpdateRequired { min_version: string; download_url: string }

interface LocalShape { auth: Auth; settings: Settings; log: string[]; updateRequired: UpdateRequired }
interface SessionShape { access: Access; run: RunState; workerTabId: number; pairing: Pairing; me: { at: number; me: MeResponse }; lastHidden: boolean }

export const local = {
  async get<K extends keyof LocalShape>(k: K): Promise<LocalShape[K] | undefined> {
    return (await chrome.storage.local.get(k))[k] as LocalShape[K] | undefined;
  },
  set<K extends keyof LocalShape>(k: K, v: LocalShape[K]) {
    return chrome.storage.local.set({ [k]: v });
  },
  remove(k: keyof LocalShape) {
    return chrome.storage.local.remove(k);
  },
};

export const session = {
  async get<K extends keyof SessionShape>(k: K): Promise<SessionShape[K] | undefined> {
    return (await chrome.storage.session.get(k))[k] as SessionShape[K] | undefined;
  },
  set<K extends keyof SessionShape>(k: K, v: SessionShape[K]) {
    return chrome.storage.session.set({ [k]: v });
  },
  remove(k: keyof SessionShape) {
    return chrome.storage.session.remove(k);
  },
};
