/**
 * The shared posting cache (decision E10): public LinkedIn posting text and facts, one row per
 * job keyed (platform, external_id), reused across users so a job one user's draft already read
 * costs no LinkedIn request and no AI extraction for the next. `first_seen_by` is written on
 * insert and never selected: every read here names its columns, and nothing returns it.
 */

import { createHash } from "node:crypto";
import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { check, unwrap } from "../../lib/errors.js";
import type { Screened } from "../linkedin/prescreen.js";

const db = () => getSupabaseClient();

/** A JD read this recently is reused instead of fetched again. */
export const FRESH_MS = 72 * 3600_000;
const COLS = "external_id, title, company, location, seniority_level, ats, closed_seen_at, jd_text, jd_fetched_at, facts, ai_facts, ai_model, ai_version";

export type Posting = {
  external_id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  seniority_level: string | null;
  ats: string | null;
  closed_seen_at: string | null;
  jd_text: string | null;
  jd_fetched_at: string | null;
  facts: Json;
  ai_facts: Json | null;
  ai_model: string | null;
  ai_version: string | null;
};

async function inChunks<T>(ids: string[], f: (chunk: string[]) => Promise<T[]>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...(await f(ids.slice(i, i + 200))));
  return out;
}

/** Postings whose JD was read in the last 72 hours. */
export async function freshPostings(ids: string[]): Promise<Map<string, Posting>> {
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const rows = await inChunks(ids, async (chunk) =>
    unwrap(
      await db().from("job_postings").select(COLS).eq("platform", "linkedin").in("external_id", chunk).gte("jd_fetched_at", since).not("jd_text", "is", null)
    ) as Posting[]
  );
  return new Map(rows.map((r) => [r.external_id, r]));
}

export async function getPosting(id: string): Promise<Posting | null> {
  const { data, error } = await db().from("job_postings").select(COLS).eq("platform", "linkedin").eq("external_id", id).maybeSingle();
  if (error) throw error;
  return data as Posting | null;
}

/** Every card that survived the title filter: new ones inserted with who found them first,
    known ones refreshed (title, company, location, last seen) without touching first_seen_by. */
export async function noteCards(userId: string, cards: { id: string; t: string; co: string; loc: string }[]) {
  if (!cards.length) return;
  const known = new Set(
    await inChunks(cards.map((c) => c.id), async (chunk) =>
      unwrap(await db().from("job_postings").select("external_id").eq("platform", "linkedin").in("external_id", chunk)).map((r) => r.external_id)
    )
  );
  const now = new Date().toISOString();
  const row = (c: (typeof cards)[number]) => ({ platform: "linkedin", external_id: c.id, title: c.t || null, company: c.co || null, location: c.loc || null, last_seen_at: now });
  const fresh = cards.filter((c) => !known.has(c.id));
  const seen = cards.filter((c) => known.has(c.id));
  if (fresh.length) {
    check(await db().from("job_postings").upsert(fresh.map((c) => ({ ...row(c), first_seen_by: userId })), { onConflict: "platform,external_id", ignoreDuplicates: true }));
  }
  if (seen.length) check(await db().from("job_postings").upsert(seen.map(row), { onConflict: "platform,external_id" }));
}

/** What a JD read taught: the text (first 20,000 characters), its hash and the deterministic facts. */
export async function storeJd(id: string, s: Screened, keep: { minY?: number | null; yu?: number; lvl?: string | null; pay?: number | null } | null) {
  const text = s.text.slice(0, 20_000);
  const now = new Date().toISOString();
  check(
    await db()
      .from("job_postings")
      .upsert(
        {
          platform: "linkedin", external_id: id, jd_text: text, jd_hash: createHash("sha256").update(text).digest("hex"), jd_fetched_at: now,
          seniority_level: s.lvl, ats: s.ats, last_seen_at: now,
          ...(s.verdict.code === "CLOSED" ? { closed_seen_at: now } : {}),
          facts: { minY: keep?.minY ?? null, yu: keep?.yu ?? 0, lvl: s.lvl, pay: keep?.pay ?? null, stack_all: s.stackAll } as Json,
        },
        { onConflict: "platform,external_id" }
      )
  );
}

export async function storeAiFacts(id: string, facts: unknown, model: string, version: string) {
  check(
    await db().from("job_postings").update({ ai_facts: facts as Json, ai_model: model, ai_version: version }).eq("platform", "linkedin").eq("external_id", id)
  );
}
