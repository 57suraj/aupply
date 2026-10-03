/**
 * Devices: one per installed extension the user approved. Listed and revoked on the website
 * like an MCP connection; a revoke is immediate (requireDevice checks every request), closes
 * the device's open leases and ends its live run.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { check, unwrap } from "../../lib/errors.js";
import { notFoundExt } from "../server/http.js";
import { logEvent } from "./events.js";

const db = () => getSupabaseClient();

export async function listDevices(userId: string) {
  return unwrap(
    await db()
      .from("ext_devices")
      .select("id, name, ext_version, created_at, last_seen_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
  );
}

export async function renameDevice(userId: string, deviceId: string, name: string) {
  const rows = unwrap(
    await db().from("ext_devices").update({ name }).eq("id", deviceId).eq("user_id", userId).is("revoked_at", null).select("id, name")
  );
  if (!rows.length) throw notFoundExt("Device");
  return rows[0];
}

export async function countDevices(userId: string) {
  const { count, error } = await db().from("ext_devices").select("id", { count: "exact", head: true }).eq("user_id", userId).is("revoked_at", null);
  if (error) throw error;
  return count ?? 0;
}

/** Revoke a device: no token of it works again. Its open leases close as REVOKED and its live
    run ends. Throws not found when the device is not this user's or already revoked. */
export async function revokeDevice(userId: string, deviceId: string, why: "web" | "signout" | "replay") {
  const now = new Date().toISOString();
  const rows = unwrap(
    await db()
      .from("ext_devices")
      .update({ revoked_at: now, refresh_token_hash: null, prev_refresh_token_hash: null })
      .eq("id", deviceId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .select("id")
  );
  if (!rows.length) throw notFoundExt("Device");
  check(
    await db()
      .from("ext_leases")
      .update({ completed_at: now, result: "REVOKED" })
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .is("completed_at", null)
  );
  check(
    await db()
      .from("runs")
      .update({ ended_at: now, summary: "ended: device disconnected" })
      .eq("user_id", userId)
      .eq("client", "aupply_extension")
      .eq("metadata->>device_id", deviceId)
      .is("ended_at", null)
  );
  await logEvent(userId, { deviceId, level: why === "replay" ? "warn" : "info", type: `device.revoked`, data: { why } });
}
