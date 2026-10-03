/**
 * The only URLs the extension navigates to or fetches (section 11.7). Anything else the server
 * sends is refused and logged: the server sends data, never code or arbitrary destinations.
 */

const ALLOWED = [
  /^https:\/\/www\.linkedin\.com\/jobs-guest\/jobs\/api\/seeMoreJobPostings\/search\?[^#]*$/,
  /^https:\/\/www\.linkedin\.com\/jobs-guest\/jobs\/api\/jobPosting\/\d{6,15}$/,
  /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d{6,15}\/?$/,
  /^https:\/\/www\.linkedin\.com\/jobs-tracker\/\?stage=applied$/,
];

export const allowed = (url: string) => ALLOWED.some((re) => re.test(url));
export const isSearchUrl = (url: string) => ALLOWED[0].test(url);
export const isJdUrl = (url: string) => ALLOWED[1].test(url);
export const isJobUrl = (url: string) => ALLOWED[2].test(url);
export const isTrackerUrl = (url: string) => ALLOWED[3].test(url);
export const TRACKER_URL = "https://www.linkedin.com/jobs-tracker/?stage=applied";

/** The job id in a job page URL (LinkedIn may land on a URL that names it as currentJobId). */
export const jobIdOf = (url: string) => /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,15})/.exec(url)?.[1] ?? /[?&]currentJobId=(\d{6,15})/.exec(url)?.[1] ?? null;
