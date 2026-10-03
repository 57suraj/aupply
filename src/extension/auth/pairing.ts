/**
 * Pairing (RFC 8628 shaped) and refresh: how an installed extension gets its own revocable
 * credential without ever seeing the user's Supabase session or an MCP token.
 *
 * 1. pair/start: the extension gets a user code (XXXX-XXXX) and a poll secret, and opens
 *    verify_url on the website.
 * 2. The website (Supabase session) shows the device and the code; the user approves or denies.
 * 3. pair/poll with the poll secret: once approved, tokens are issued exactly once.
 * Refresh rotates the refresh token on every use; a replayed old token revokes the device.
 */

import crypto from "node:crypto";
import { BASE_URL } from "../../config.js";
import { getSupabaseClient } from "../../db/supabase.js";
import { unwrap, unwrapMaybe } from "../../lib/errors.js";
import { USER_CODE, type PairPollResponse, type PairStartRequest, type PairStartResponse, type WebPairDecisionResponse, type WebPairInfo } from "../contract.js";
import { ExtError, conflict, notFoundExt, unauthorized } from "../server/http.js";
import { revokeDevice } from "../services/devices.js";
import { logEvent } from "../services/events.js";
import { issueTokens, randomSecret, sameHash, sha256 } from "./tokens.js";

const db = () => getSupabaseClient();

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_TTL_MS = 10 * 60_000;
/** An approved pairing can still be collected this long after the code expired. */
const COLLECT_GRACE_MS = 10 * 60_000;
const POLL_MIN_GAP_MS = 2_000;
const PAIRINGS_PER_IP_PER_HOUR = 10;
/** A benign race: two extension contexts refreshing at once. Older replays revoke the device. */
const ROTATION_GRACE_MS = 2 * 60_000;

const newCode = () => {
  const c = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/** A code as the user may type it: any case, with or without the dash. */
export function normalizeCode(raw: string): string | null {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const code = s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : "";
  return USER_CODE.test(code) ? code : null;
}

export async function startPairing(input: PairStartRequest, ip: string): Promise<PairStartResponse> {
  const now = Date.now();
  // Housekeeping on every start: pairings that expired more than a day ago.
  await db().from("ext_pairings").delete().lt("expires_at", new Date(now - 24 * 3600_000).toISOString());
  const { count } = await db()
    .from("ext_pairings")
    .select("id", { count: "exact", head: true })
    .eq("metadata->>ip", ip)
    .gte("created_at", new Date(now - 3600_000).toISOString());
  if ((count ?? 0) >= PAIRINGS_PER_IP_PER_HOUR) {
    throw new ExtError(429, "slow_down", "Too many connection attempts from this network. Try again in an hour.", { retry_after_s: 3600 });
  }
  const pollSecret = randomSecret(32);
  const expiresAt = new Date(now + PAIR_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const { data, error } = await db()
      .from("ext_pairings")
      .insert({
        user_code: code,
        poll_secret_hash: sha256(pollSecret),
        device_name: input.device_name,
        ext_version: input.ext_version ?? null,
        expires_at: expiresAt,
        metadata: { ip },
      })
      .select("id")
      .single();
    if (error?.code === "23505") continue; // the code is taken: draw again
    const row = unwrap({ data, error });
    return {
      pair_id: row.id,
      user_code: code,
      poll_secret: pollSecret,
      verify_url: `${BASE_URL}/extension/connect?code=${code}`,
      expires_at: expiresAt,
      interval_s: 3,
    };
  }
  throw new Error("could not draw a free pairing code");
}

const PAIR_COLS = "id, user_code, device_name, ext_version, user_id, device_id, approved_at, denied_at, consumed_at, last_polled_at, expires_at, created_at, poll_secret_hash";

async function pairingByCode(code: string) {
  return unwrapMaybe(await db().from("ext_pairings").select(PAIR_COLS).eq("user_code", code).maybeSingle());
}

/** The website's view of a pairing: unexpired and not yet collected, and not another user's. */
export async function webPairInfo(userId: string, rawCode: string): Promise<WebPairInfo> {
  const code = normalizeCode(rawCode);
  const p = code ? await pairingByCode(code) : null;
  if (!p || p.consumed_at || Date.parse(p.expires_at) <= Date.now() || (p.user_id && p.user_id !== userId)) throw notFoundExt("Connection code");
  return {
    device_name: p.device_name,
    ext_version: p.ext_version,
    created_at: p.created_at,
    expires_at: p.expires_at,
    status: p.approved_at ? "approved" : p.denied_at ? "denied" : "pending",
  };
}

/** Approve (creates the device for this user) or deny. Idempotent for the same user. */
export async function webPairDecide(userId: string, rawCode: string, approve: boolean): Promise<WebPairDecisionResponse> {
  const code = normalizeCode(rawCode);
  const p = code ? await pairingByCode(code) : null;
  if (!p || p.consumed_at || Date.parse(p.expires_at) <= Date.now()) throw notFoundExt("Connection code");
  if (p.user_id && p.user_id !== userId) throw conflict("This code was already used by another account.");
  if (p.approved_at) {
    if (!approve) throw conflict("This code was already approved.");
    return { status: "approved", device: { id: p.device_id!, name: p.device_name } };
  }
  if (p.denied_at) {
    if (approve) throw conflict("This code was denied. Start again from the extension.");
    return { status: "denied" };
  }
  const now = new Date().toISOString();
  if (!approve) {
    unwrap(await db().from("ext_pairings").update({ denied_at: now, user_id: userId }).eq("id", p.id).is("approved_at", null).select("id"));
    return { status: "denied" };
  }
  const device = unwrap(
    await db().from("ext_devices").insert({ user_id: userId, name: p.device_name, ext_version: p.ext_version }).select("id, name").single()
  );
  const claimed = unwrap(
    await db()
      .from("ext_pairings")
      .update({ user_id: userId, device_id: device.id, approved_at: now })
      .eq("id", p.id)
      .is("approved_at", null)
      .is("denied_at", null)
      .select("id")
  );
  if (!claimed.length) {
    // Lost a race with another decision on the same code: undo and answer from the stored state.
    await db().from("ext_devices").delete().eq("id", device.id).eq("user_id", userId);
    return webPairDecide(userId, rawCode, approve);
  }
  await logEvent(userId, { deviceId: device.id, level: "info", type: "device.paired", data: { ext_version: p.ext_version } });
  return { status: "approved", device: { id: device.id, name: device.name } };
}

/** The extension polls with its secret; tokens come back exactly once. */
export async function pollPairing(pairId: string, pollSecret: string): Promise<PairPollResponse> {
  const p = unwrapMaybe(await db().from("ext_pairings").select(PAIR_COLS).eq("id", pairId).maybeSingle());
  if (!p || !sameHash(p.poll_secret_hash, sha256(pollSecret))) throw notFoundExt("Pairing");
  const now = Date.now();
  if (p.last_polled_at && now - Date.parse(p.last_polled_at) < POLL_MIN_GAP_MS) {
    throw new ExtError(429, "slow_down", "Polling too fast.", { retry_after_s: 3 });
  }
  await db().from("ext_pairings").update({ last_polled_at: new Date(now).toISOString() }).eq("id", p.id);
  if (p.consumed_at) return { status: "expired" };
  if (p.denied_at) return { status: "denied" };
  if (!p.approved_at) return Date.parse(p.expires_at) <= now ? { status: "expired" } : { status: "pending" };
  if (Date.parse(p.expires_at) + COLLECT_GRACE_MS <= now || !p.user_id || !p.device_id) return { status: "expired" };
  // Collect once: whoever marks it consumed first gets the tokens.
  const taken = unwrap(
    await db().from("ext_pairings").update({ consumed_at: new Date(now).toISOString() }).eq("id", p.id).is("consumed_at", null).select("id")
  );
  if (!taken.length) return { status: "expired" };
  const issued = await issueTokens(p.user_id, p.device_id);
  const device = unwrap(
    await db()
      .from("ext_devices")
      .update({ refresh_token_hash: issued.refreshHash, refresh_token_expires_at: issued.refreshExpiresAt, rotated_at: new Date(now).toISOString() })
      .eq("id", p.device_id)
      .eq("user_id", p.user_id)
      .is("revoked_at", null)
      .select("id, name")
  );
  if (!device.length) return { status: "expired" }; // revoked on the website before it was collected
  return { status: "approved", device: { id: device[0].id, name: device[0].name }, tokens: issued.tokens };
}

/** Rotate a refresh token. The previous token within 2 minutes: 409 (a benign race). Later:
    a replay, so the device is revoked. */
export async function refreshTokens(refreshToken: string) {
  const hash = sha256(refreshToken);
  const now = Date.now();
  const cur = unwrapMaybe(
    await db()
      .from("ext_devices")
      .select("id, user_id, revoked_at, refresh_token_expires_at")
      .eq("refresh_token_hash", hash)
      .maybeSingle()
  );
  if (cur) {
    if (cur.revoked_at) throw new ExtError(401, "device_revoked", "This browser was disconnected from Aupply. Connect it again.");
    if (!cur.refresh_token_expires_at || Date.parse(cur.refresh_token_expires_at) <= now) throw unauthorized();
    const issued = await issueTokens(cur.user_id, cur.id);
    const rotated = unwrap(
      await db()
        .from("ext_devices")
        .update({
          refresh_token_hash: issued.refreshHash,
          prev_refresh_token_hash: hash,
          rotated_at: new Date(now).toISOString(),
          refresh_token_expires_at: issued.refreshExpiresAt,
        })
        .eq("id", cur.id)
        .eq("user_id", cur.user_id)
        .eq("refresh_token_hash", hash)
        .select("id")
    );
    if (!rotated.length) throw conflict("This token was already rotated: use the newest one.");
    return issued.tokens;
  }
  const prev = unwrap(
    await db()
      .from("ext_devices")
      .select("id, user_id, rotated_at, revoked_at")
      .eq("prev_refresh_token_hash", hash)
      .is("revoked_at", null)
      .limit(1)
  )[0];
  if (prev) {
    if (prev.rotated_at && now - Date.parse(prev.rotated_at) < ROTATION_GRACE_MS) {
      throw conflict("This token was already rotated: use the newest one.");
    }
    await revokeDevice(prev.user_id, prev.id, "replay");
    throw new ExtError(401, "device_revoked", "This browser was disconnected from Aupply for safety. Connect it again.");
  }
  throw unauthorized();
}
