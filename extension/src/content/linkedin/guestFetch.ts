/**
 * Guest search and JD fetches, made from the worker tab with the user's own browser (Aupply's
 * servers never contact LinkedIn). One request at a time, the server's gap or the floor, whichever
 * is longer; a 429, a 999, or (JD) an empty 200 body is a rate limit and stops the batch at once
 * (li_sweep.js, li_screen.js). Raw bodies go to the server, which parses them.
 */

import { isJdUrl, isSearchUrl } from "../../shared/allowlist";
import { FLOORS, LIMITS } from "../../shared/constants";
import { sleep } from "../sleep";

async function get(url: string): Promise<{ status: number; html: string }> {
  try {
    const r = await fetch(url, { credentials: "include" });
    const html = r.ok ? await r.text() : "";
    return { status: r.status, html: html.slice(0, LIMITS.maxHtml) };
  } catch {
    return { status: -1, html: "" };
  }
}

export async function searchPages(args: { pages: { url: string }[]; gap_ms: number }, progress: (n: string) => void) {
  const out: { url: string; status: number; html: string }[] = [];
  const gap = Math.max(args.gap_ms || 0, FLOORS.searchGapMs);
  for (const [i, p] of args.pages.entries()) {
    if (!isSearchUrl(p.url)) throw new Error(`refused a URL outside the allowlist`);
    if (i) await sleep(gap);
    const r = await get(p.url);
    out.push({ url: p.url, ...r });
    progress(`search ${i + 1}/${args.pages.length}`);
    if (r.status === 429 || r.status === 999) return { pages: out, stopped: "rate_limited" as const };
  }
  return { pages: out };
}

export async function jdPages(args: { jobs: { id: string; url: string }[]; gap_ms: number }, progress: (n: string) => void) {
  const out: { id: string; status: number; html: string }[] = [];
  const gap = Math.max(args.gap_ms || 0, FLOORS.jdGapMs);
  for (const [i, j] of args.jobs.entries()) {
    if (!isJdUrl(j.url) || !j.url.endsWith(`/${j.id}`)) throw new Error(`refused a URL outside the allowlist`);
    if (i) await sleep(gap);
    const r = await get(j.url);
    out.push({ id: j.id, ...r });
    progress(`job description ${i + 1}/${args.jobs.length}`);
    // An empty body is a rate limit, not "no years stated".
    if (r.status === 429 || r.status === 999 || (r.status === 200 && !r.html.trim())) return { jobs: out, stopped: "rate_limited" as const };
  }
  return { jobs: out };
}
