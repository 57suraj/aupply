/**
 * Runs: one row per Claude application session, for throughput over time.
 */

import type { z } from "zod";
import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { notFound, unwrap, unwrapMaybe } from "../lib/errors.js";
import type { RunInput } from "../domain/schemas.js";

const db = () => getSupabaseClient();

/** Open a run (no run_id) or update one: summary, stats, and `ended` closes it. */
export async function logRun(userId: string, input: z.infer<typeof RunInput>) {
  const { run_id, ended, stats, metadata, ...fields } = input;
  const values = {
    ...fields,
    ...(stats ? { stats: stats as Json } : {}),
    ...(metadata ? { metadata: metadata as Json } : {}),
    ...(ended ? { ended_at: new Date().toISOString() } : {}),
  };

  if (!run_id) {
    return unwrap(await db().from("runs").insert({ ...values, user_id: userId }).select("*").single());
  }
  const row = unwrapMaybe(
    await db().from("runs").update(values).eq("id", run_id).eq("user_id", userId).select("*").maybeSingle()
  );
  if (!row) throw notFound("Run");
  return row;
}

export async function listRuns(userId: string, limit = 50) {
  return unwrap(
    await db()
      .from("runs")
      .select("*")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(Math.min(limit, 200))
  );
}
