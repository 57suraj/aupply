/**
 * Helpers shared by the platform tools: the job list an apply tool works on (ids,
 * links, or the drafted queue), and the response when a platform is in a backoff.
 */

import type { PostedWithin } from "../domain/schemas.js";
import { AppError } from "../lib/errors.js";
import { jobsById, queuedJobs } from "../services/automation.js";
import { jobUrl, tryCanonicalJobId, wellfoundSlug, type ScriptedPlatform } from "./ids.js";

export interface ApplyJob { id: string; co: string; url: string | null }

// saved: not Easy Apply, waiting on the dashboard for the user to apply by hand.
const DONE = new Set(["applied", "unconfirmed", "parked", "closed", "saved"]);

export async function applyList(
  userId: string,
  platform: ScriptedPlatform,
  args: { jobs?: string[]; from_queue?: boolean; limit?: number },
  max: number,
  within?: PostedWithin
) {
  const dropped: [string, string][] = [];
  let list: ApplyJob[] = [];
  if (args.jobs?.length) {
    const parsed = args.jobs.map((raw) => ({ raw, id: tryCanonicalJobId(platform, raw) }));
    parsed.filter((p) => !p.id).forEach((p) => dropped.push([p.raw.slice(0, 80), "unrecognised id"]));
    const rows = new Map((await jobsById(userId, platform, parsed.flatMap((p) => (p.id ? [p.id] : [])))).map((r) => [r.external_id as string, r]));
    for (const { raw, id } of parsed) {
      if (!id) continue;
      const row = rows.get(id);
      // An external ATS behind a LinkedIn posting: not Easy Apply, and the case that
      // tripped Claude's permission check on 28 Sep.
      const ats = raw.match(/applicantTrackingSystemName=([A-Za-z]+)/)?.[1];
      if (platform === "linkedin" && ats && !/linkedin/i.test(ats)) { dropped.push([id, `external ATS (${ats})`]); continue; }
      if (row && DONE.has(row.status)) { dropped.push([id, row.status === "saved" ? "not Easy Apply: saved for a manual apply" : `already ${row.status}`]); continue; }
      const url = platform === "wellfound" ? (wellfoundSlug(raw) ? jobUrl(platform, id, wellfoundSlug(raw)) : row?.job_url ?? null) : jobUrl(platform, id);
      if (!url) { dropped.push([id, "Wellfound needs the full job URL (a bare id 404s)"]); continue; }
      list.push({ id, co: row && row.company_name !== "(unknown)" ? row.company_name : "", url });
    }
  } else if (args.from_queue) {
    list = (await queuedJobs(userId, platform, max, within)).map((r) => ({
      id: r.external_id as string,
      co: r.company_name !== "(unknown)" ? r.company_name : "",
      url: r.job_url,
    }));
  } else {
    throw new AppError("Pass jobs (ids or links) or from_queue: true.");
  }
  const limit = Math.min(args.limit ?? max, max);
  if (list.length > limit) {
    list.slice(limit).forEach((j) => dropped.push([j.id, "over this run's limit"]));
    list = list.slice(0, limit);
  }
  return { list, dropped };
}

export const blocked = (b: { scope: string; until: string | null; reason: string | null }) => ({
  blocked: true,
  scope: b.scope,
  until: b.until,
  reason: b.reason,
  next: `Rate-limit backoff: do not touch ${b.scope} until ${b.until}. Work another platform meanwhile.`,
});

export const slugify = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
