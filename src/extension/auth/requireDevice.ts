/**
 * requireDevice: authenticates the extension's calls with its device access token. One
 * lookup per request makes a revoke on the website immediate. MCP tokens and Supabase
 * session tokens fail here (different secret and audience).
 */

import type { NextFunction, Request, Response } from "express";
import { getSupabaseClient } from "../../db/supabase.js";
import { unwrapMaybe } from "../../lib/errors.js";
import { VERSION_HEADER } from "../contract.js";
import { ExtError, unauthorized } from "../server/http.js";
import { verifyDeviceAccess } from "./tokens.js";

export interface DeviceAuth {
  userId: string;
  deviceId: string;
  name: string;
  /** The extension version the request says it is. */
  version: string | null;
}

const TOUCH_EVERY_MS = 60_000;

export async function requireDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw unauthorized("Missing device token.");
  const { userId, deviceId } = await verifyDeviceAccess(token);
  const db = getSupabaseClient();
  const row = unwrapMaybe(
    await db
      .from("ext_devices")
      .select("id, name, revoked_at, last_seen_at, ext_version")
      .eq("id", deviceId)
      .eq("user_id", userId)
      .maybeSingle()
  );
  if (!row) throw unauthorized();
  if (row.revoked_at) throw new ExtError(401, "device_revoked", "This browser was disconnected from Aupply. Connect it again.");
  const version = req.get(VERSION_HEADER)?.trim() || null;
  // last_seen_at and the version at most once a minute (or when the version changes).
  const stale = !row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS;
  if (stale || (version && version !== row.ext_version)) {
    const { error } = await db
      .from("ext_devices")
      .update({ last_seen_at: new Date().toISOString(), ...(version ? { ext_version: version } : {}) })
      .eq("id", deviceId)
      .eq("user_id", userId);
    if (error) console.error("[ext] device touch failed", error.message);
  }
  res.locals.device = { userId, deviceId, name: row.name, version } satisfies DeviceAuth;
  next();
}

/** The device for a request that passed requireDevice. */
export function deviceOf(res: Response): DeviceAuth {
  const d = res.locals.device as DeviceAuth | undefined;
  if (!d) throw new Error("requireDevice did not run.");
  return d;
}
