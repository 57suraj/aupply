/**
 * Questions only the user can answer, and the user's stack decisions (section 8.6). Stack
 * decisions keep queue_jobs' semantics: keep clears needs_decision (the form then answers No /
 * 0 years for that technology, the resolver's far-technology rule); drop skips the job.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { check, unwrap } from "../../lib/errors.js";
import { QUEUE_MAX_AGE_HOURS } from "../../services/automation.js";
import type { DecisionItem } from "../contract.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

const decisionRows = (userId: string) =>
  db()
    .from("applications")
    .select("id, external_id, job_title, company_name, match_score, metadata")
    .eq("user_id", userId)
    .eq("platform", "linkedin")
    .eq("status", "discovered")
    .eq("metadata->>needs_decision", "true")
    .gte("created_at", new Date(Date.now() - QUEUE_MAX_AGE_HOURS.linkedin * 3600_000).toISOString());

export async function listDecisions(userId: string): Promise<{ items: DecisionItem[] }> {
  const rows = unwrap(await decisionRows(userId).order("match_score", { ascending: false, nullsFirst: false }).limit(200));
  return {
    items: rows.map((r) => {
      const m = (r.metadata as Meta | null) ?? {};
      return {
        id: r.id, job_id: r.external_id ?? "", title: r.job_title, company: r.company_name,
        wants: Array.isArray(m.sm) ? m.sm : [], score: r.match_score, reasons: Array.isArray(m.ai?.reasons) ? m.ai.reasons : [],
      };
    }),
  };
}

export async function decide(userId: string, items: { id: string; keep: boolean }[]) {
  const rows = unwrap(await decisionRows(userId).in("id", items.map((i) => i.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let kept = 0, dropped = 0;
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) continue;
    const metadata = { ...((row.metadata as Meta) ?? {}), needs_decision: false } as Json;
    check(
      await db()
        .from("applications")
        .update(item.keep ? { metadata } : { metadata, status: "skipped", status_reason: "stack_declined: the user chose not to apply" })
        .eq("id", row.id)
        .eq("user_id", userId)
    );
    if (item.keep) kept++;
    else dropped++;
  }
  return { kept, dropped };
}
