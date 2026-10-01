/**
 * A strong match: a job worth the user's own time when Aupply cannot apply to it (not Easy
 * Apply), so it is saved for them to apply to by hand. Every check must pass, which keeps the
 * saved list short (a nice-to-have, not a second queue): the title names one of the user's
 * roles, the JD names no technology from a language or platform they have no foothold in, it
 * is not a job-ad network repost, and the stated years and seniority fit.
 */

/** What a draft stored about a job (applications.metadata). */
export interface DraftFacts {
  sm?: string[];
  agg?: number;
  yu?: number;
  lvl?: string | null;
  needs_decision?: boolean;
}

const GENERIC = new Set(["engineer", "developer", "software", "sde", "programmer", "jr", "junior", "associate", "i", "ii", "and", "of", "the"]);
const words = (s: string) =>
  s.toLowerCase()
    .replace(/full[\s-]?stack/g, "fullstack")
    .replace(/back[\s-]?end/g, "backend")
    .replace(/front[\s-]?end/g, "frontend")
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);

/** The title names one of the roles: every distinctive word of the role ("backend" in
    "Backend Engineer"), or every word when the role is all generic ("Software Engineer"). */
export function titleMatchesRole(title: string, roles: string[]): boolean {
  const t = new Set(words(title));
  return roles.some((r) => {
    const all = words(r);
    const distinct = all.filter((w) => !GENERIC.has(w));
    return (distinct.length ? distinct : all).every((w) => t.has(w));
  });
}

export function strongMatch(
  job: { title: string; minYears: number | null; facts: DraftFacts },
  user: { roles: string[]; years: number | null }
): boolean {
  const f = job.facts;
  if (f.agg || f.yu || f.sm?.length || f.needs_decision) return false;
  if (/mid-senior|director|executive/i.test(f.lvl ?? "")) return false;
  if (job.minYears != null && job.minYears > Math.max(1, user.years ?? 0)) return false;
  return titleMatchesRole(job.title, user.roles);
}
