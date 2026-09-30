/**
 * Job identity: the platform's own job id in one canonical form, so
 * (user_id, platform, external_id) dedups reliably whatever Claude passes in
 * (a bare id, a URL, a LinkedIn URN). A DB CHECK enforces the same forms for the
 * scripted platforms (migration automation_platform_state).
 */

import { AppError } from "../lib/errors.js";

export const SCRIPTED_PLATFORMS = ["linkedin", "naukri", "wellfound", "indeed"] as const;
export type ScriptedPlatform = (typeof SCRIPTED_PLATFORMS)[number];

export const isScripted = (p: string): p is ScriptedPlatform => (SCRIPTED_PLATFORMS as readonly string[]).includes(p);

const first = (s: string, ...res: RegExp[]) => {
  for (const re of res) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
};

const PARSERS: Record<ScriptedPlatform, { parse: (s: string) => string | null; hint: string }> = {
  linkedin: {
    parse: (s) =>
      first(s, /^(\d{6,15})$/, /urn:li:jobPosting:(\d{6,15})/, /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,15})(?:[/?#]|$)/, /[?&]currentJobId=(\d{6,15})/),
    hint: "Pass the numeric job id or a linkedin.com/jobs/view/<id> link.",
  },
  naukri: {
    parse: (s) => first(s, /^(\d{10,14})$/, /-(\d{10,14})(?:[/?#]|$)/, /[?&]jobId=(\d{10,14})/),
    hint: "Pass the Naukri job id (the number at the end of the job-listings URL) or the link.",
  },
  wellfound: {
    parse: (s) => first(s, /^(\d{3,12})$/, /\/jobs\/(\d{3,12})(?:-[a-z0-9-]*)?(?:[/?#]|$)/, /^(\d{3,12})-[a-z0-9-]+$/),
    hint: "Pass the Wellfound job URL (wellfound.com/jobs/<id>-<slug>).",
  },
  indeed: {
    parse: (s) => {
      if (/JOBSEARCH_|to\.indeed\.com/i.test(s)) return null;
      const jk = first(s.toLowerCase(), /^([0-9a-f]{16})$/, /[?&]v?jk=([0-9a-f]{16})/);
      return jk;
    },
    hint: "Pass the Indeed jk (16 hex characters) or a link containing jk=. Connector ids (JOBSEARCH_nn) and to.indeed.com links change on every call; resolve them to the jk first.",
  },
};

/** Canonical id for `raw` on `platform`. Throws for an unrecognised id on a scripted platform. */
export function canonicalJobId(platform: string, raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new AppError("Empty job id.");
  if (isScripted(platform)) {
    const id = PARSERS[platform].parse(s);
    if (!id) throw new AppError(`Unrecognised ${platform} job id "${s.slice(0, 80)}". ${PARSERS[platform].hint}`);
    return id;
  }
  // Other sites: the URL without query string, fragment or trailing slash, or the id as given.
  try {
    const u = new URL(s);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`.slice(0, 200);
  } catch {
    return s.slice(0, 200);
  }
}

/** Like canonicalJobId, but returns null instead of throwing. */
export function tryCanonicalJobId(platform: string, raw: string): string | null {
  try {
    return canonicalJobId(platform, raw);
  } catch {
    return null;
  }
}

/** The slug part of a Wellfound job URL, needed to open the job (a bare id 404s). */
export function wellfoundSlug(raw: string): string | null {
  return String(raw).match(/\/jobs\/\d+-([a-z0-9-]+)/)?.[1] ?? String(raw).match(/^\d+-([a-z0-9-]+)$/)?.[1] ?? null;
}

export function jobUrl(platform: string, id: string, slug?: string | null): string | null {
  switch (platform) {
    case "linkedin":
      return `https://www.linkedin.com/jobs/view/${id}/`;
    case "naukri":
      return `https://www.naukri.com/job-listings-x-y-${id}`;
    case "wellfound":
      return slug ? `https://wellfound.com/jobs/${id}-${slug}` : null;
    case "indeed":
      return `https://in.indeed.com/viewjob?jk=${id}`;
    default:
      return null;
  }
}
