/**
 * LinkedIn's public guest job search: the URLs a draft asks the extension to fetch, and the
 * parser for what comes back. Ported from li_sweep.js (src/engines/src/modules/li_sweep.js,
 * `parseCards` and the URL in `sweep`): the same parameters and the same regexes, so both
 * channels read a page identically. Regex, not DOMParser: that is what the MCP engine proved
 * (Trusted Types blocked DOMParser in the page), and it keeps the two parsers one.
 * The server only builds these strings; it never fetches LinkedIn (decision D1).
 */

import type { PostedWithin } from "../contract.js";
import { engineDefs } from "../engine/modules.js";

export interface Card { id: string; t: string; co: string; loc: string }

/** li_sweep `parseCards`: split on <li, one card per job posting URN. */
export function parseCards(html: string): Card[] {
  const { clean } = engineDefs();
  const out: Card[] = [];
  for (const ch of String(html || "").split(/<li[\s>]/)) {
    const u = /data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(ch);
    if (!u) continue;
    const ti = /base-search-card__title"[^>]*>([\s\S]*?)<\//.exec(ch);
    const co = /base-search-card__subtitle"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(ch);
    const lo = /job-search-card__location"[^>]*>([\s\S]*?)<\//.exec(ch);
    out.push({ id: u[1], t: clean(ti ? ti[1] : ""), co: clean(co ? co[1] : ""), loc: clean(lo ? lo[1] : "") });
  }
  return out;
}

/** li_sweep: f_TPR per window. */
const TPR: Record<PostedWithin, string> = { "1h": "r3600", "24h": "r86400", "1w": "r604800" };

/** li_sweep `sweep`: Easy Apply only (f_AL), newest first, ten cards a page. */
export function searchUrl(o: { keyword: string; location: string; geoId: string | null; window: PostedWithin; page: number }): string {
  const u = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  u.searchParams.set("keywords", o.keyword);
  u.searchParams.set("location", o.location || "India");
  if (o.geoId) u.searchParams.set("geoId", o.geoId);
  u.searchParams.set("f_TPR", TPR[o.window] ?? "r86400");
  u.searchParams.set("f_AL", "true");
  u.searchParams.set("sortBy", "DD");
  u.searchParams.set("start", String(o.page * 10));
  return u.toString();
}

/** li_screen `jd`: the guest JD endpoint for one job. */
export const jdUrl = (id: string) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

/** A page of the guest search holds ten cards; fewer ends that search's paging (li_sweep). */
export const PAGE_SIZE = 10;
