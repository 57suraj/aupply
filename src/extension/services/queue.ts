/**
 * The LinkedIn queue as the extension sees it: the MCP's own queue (queuedJobs: discovered,
 * not waiting on a stack decision, inside the 24h queue age and the session's posted_within),
 * minus jobs waiting on the user's answer (metadata.needs_input) and jobs whose retry is not
 * due yet (metadata.retry_after). Shared by /me, apply/next and the queue view.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { unwrap } from "../../lib/errors.js";
import { QUEUE_MAX_AGE_HOURS, queuedJobs } from "../../services/automation.js";
import type { PostedWithin, QueueResponse } from "../contract.js";
import { notFoundExt } from "../server/http.js";

type Meta = Record<string, any>;

export const metaOf = (row: { metadata: unknown }) => ((row.metadata as Meta | null) ?? {}) as Meta;
export const waitingOnUser = (m: Meta) => Array.isArray(m.needs_input) && m.needs_input.length > 0;
export const retryLater = (m: Meta, now = Date.now()) => typeof m.retry_after === "string" && Date.parse(m.retry_after) > now;

/** The queue split into what can be applied to now and what waits on the user, best first. */
export async function linkedinQueue(userId: string, within: PostedWithin, limit = 500) {
  const rows = await queuedJobs(userId, "linkedin", limit, within);
  const now = Date.now();
  return {
    ready: rows.filter((r) => !waitingOnUser(metaOf(r)) && !retryLater(metaOf(r), now)),
    waiting: rows.filter((r) => waitingOnUser(metaOf(r))),
  };
}

/** Discovered LinkedIn jobs waiting on the user's keep-or-drop for a far technology. */
export async function decisionCount(userId: string) {
  const since = new Date(Date.now() - QUEUE_MAX_AGE_HOURS.linkedin * 3600_000).toISOString();
  const { count, error } = await getSupabaseClient()
    .from("applications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("platform", "linkedin")
    .eq("status", "discovered")
    .eq("metadata->>needs_decision", "true")
    .gte("created_at", since);
  if (error) throw error;
  return count ?? 0;
}

/** GET /linkedin/queue: the ready queue in apply order, full strings (section 8.7). */
export async function queueView(userId: string, within: PostedWithin): Promise<QueueResponse> {
  const { ready, waiting } = await linkedinQueue(userId, within, 100);
  const ids = ready.map((r) => r.external_id as string);
  const rows = ids.length
    ? unwrap(
        await getSupabaseClient().from("applications").select("id, external_id, location, match_score").eq("user_id", userId).eq("platform", "linkedin").in("external_id", ids)
      )
    : [];
  const byExt = new Map(rows.map((r) => [r.external_id as string, r]));
  return {
    posted_within: within,
    waiting_on_you: waiting.length,
    items: ready.flatMap((r) => {
      const row = byExt.get(r.external_id as string);
      if (!row) return [];
      const m = metaOf(r);
      return [{
        id: row.id, job_id: r.external_id as string, title: r.job_title, company: r.company_name, location: row.location,
        score: row.match_score, verdict: m.ai?.verdict ?? null, reasons: m.ai?.reasons ?? [], gaps: m.ai?.gaps ?? [], window: m.w ?? null,
      }];
    }),
  };
}

/** POST /linkedin/queue/:id/skip: the user removes a job from the queue. */
export async function skipQueued(userId: string, id: string) {
  const rows = unwrap(
    await getSupabaseClient()
      .from("applications")
      .update({ status: "skipped", status_reason: "user removed from queue" })
      .eq("id", id)
      .eq("user_id", userId)
      .eq("platform", "linkedin")
      .eq("status", "discovered")
      .select("id")
  );
  if (!rows.length) throw notFoundExt("Queued job");
  return { ok: true as const };
}
