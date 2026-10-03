/**
 * Leases (section 7.7): every unit of LinkedIn work handed to a device (a batch of search
 * pages, a batch of JD fetches, one job to apply to, one tracker read). At most one open lease
 * per user and platform, across devices and kinds, so a draft and an apply, or two devices,
 * never touch LinkedIn at once (docs/automation-tools.md, Rate limits). public.ext_issue_lease
 * makes issuing atomic; pacing (not_before) is decided by the caller.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Database, Json } from "../../db/database.types.js";
import { unwrap, unwrapMaybe } from "../../lib/errors.js";
import { forbidden, notFoundExt } from "../server/http.js";

const db = () => getSupabaseClient();

export type LeaseRow = Database["public"]["Tables"]["ext_leases"]["Row"];
export type LeaseKind = "search" | "jd" | "apply" | "tracker";

/** Seconds a lease stays valid after not_before: apply is the MCP's 240s job limit plus navigation. */
export const LEASE_TTL: Record<LeaseKind, number> = { search: 120, jd: 180, apply: 360, tracker: 90 };

/** Close this user's (or everyone's) open leases that ran out of time, as EXPIRED. An expired
    apply lease means the extension vanished mid-job: it is settled as ERR for its job. */
export async function closeExpiredLeases(userId?: string): Promise<number> {
  const now = new Date().toISOString();
  let q = db().from("ext_leases").update({ completed_at: now, result: "EXPIRED" }).is("completed_at", null).lt("expires_at", now);
  if (userId) q = q.eq("user_id", userId);
  const rows = unwrap(await q.select("*"));
  const applies = rows.filter((r) => r.kind === "apply");
  if (applies.length) {
    // Loaded on demand: apply.ts imports this module.
    const { settleExpiredApplies } = await import("./apply.js");
    await settleExpiredApplies(applies);
  }
  return rows.length;
}

export type Issued =
  | { issued: true; lease: LeaseRow }
  | { issued: false; open_lease_id: string; device_id: string; kind: LeaseKind; expires_at: string };

export async function issueLease(
  userId: string,
  o: {
    deviceId: string;
    runId: string;
    kind: LeaseKind;
    applicationId?: string | null;
    externalId?: string | null;
    payload?: Record<string, unknown>;
    notBefore: Date;
    ttlSeconds?: number;
  }
): Promise<Issued> {
  await closeExpiredLeases(userId);
  const { data, error } = await db().rpc("ext_issue_lease", {
    p_user_id: userId,
    p_device_id: o.deviceId,
    p_run_id: o.runId,
    p_platform: "linkedin",
    p_kind: o.kind,
    p_application_id: (o.applicationId ?? null) as string,
    p_external_id: (o.externalId ?? null) as string,
    p_payload: (o.payload ?? {}) as Json,
    p_not_before: o.notBefore.toISOString(),
    p_ttl_seconds: o.ttlSeconds ?? LEASE_TTL[o.kind],
  });
  if (error) throw error;
  return data as unknown as Issued;
}

/** A lease of this user, checked against the calling device (another device's lease is 403). */
export async function getLease(userId: string, leaseId: string, deviceId: string, kind?: LeaseKind | LeaseKind[]) {
  const row = unwrapMaybe(await db().from("ext_leases").select("*").eq("id", leaseId).eq("user_id", userId).maybeSingle());
  if (!row) throw notFoundExt("Lease");
  if (row.device_id !== deviceId) throw forbidden("This lease belongs to another device.");
  if (kind && !(Array.isArray(kind) ? kind : [kind]).includes(row.kind as LeaseKind)) throw notFoundExt("Lease");
  return row;
}

/** Complete a lease once. Returns { first: false, lease } when it was already completed, so a
    repeated result is answered from what is stored and never processed twice. */
export async function completeLease(userId: string, lease: LeaseRow, result: string, detail?: Record<string, unknown>) {
  if (lease.completed_at) return { first: false as const, lease };
  const rows = unwrap(
    await db()
      .from("ext_leases")
      .update({
        completed_at: new Date().toISOString(),
        result,
        ...(detail ? { detail: { ...((lease.detail as Record<string, unknown>) ?? {}), ...detail } as Json } : {}),
      })
      .eq("id", lease.id)
      .eq("user_id", userId)
      .is("completed_at", null)
      .select("*")
  );
  if (!rows.length) {
    const again = unwrapMaybe(await db().from("ext_leases").select("*").eq("id", lease.id).eq("user_id", userId).maybeSingle());
    return { first: false as const, lease: again ?? lease };
  }
  return { first: true as const, lease: rows[0] };
}

/** Merge into a lease's detail while it is open (the Q&A recorded per form page). */
export async function addLeaseDetail(userId: string, lease: LeaseRow, patch: Record<string, unknown>) {
  const detail = { ...((lease.detail as Record<string, unknown>) ?? {}), ...patch } as Json;
  unwrap(await db().from("ext_leases").update({ detail }).eq("id", lease.id).eq("user_id", userId).select("id"));
  return detail;
}

/** The last completed lease of a kind for this user (pacing: not_before of the next one). */
export async function lastCompleted(userId: string, kinds: LeaseKind[]) {
  return unwrapMaybe(
    await db()
      .from("ext_leases")
      .select("id, kind, completed_at, run_id, result")
      .eq("user_id", userId)
      .eq("platform", "linkedin")
      .in("kind", kinds)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}
