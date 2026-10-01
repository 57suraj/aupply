# Automation tools

**Status: built 30 Sep 2026, not yet live-tested in a browser.** See "Build status" below
for what exists and where it differs from this design. Written 30 Sep 2026 from the applix scripts
(`/Users/suraj/applix/scripts`, 16 to 19 Sep) and the applix Drive pack (folder
`1ISY883-VdE9OS52xPU2-wDLfbfbWOrJ0`: runbook, `04a-sweeps.js`, amendments 1 to 84, and
`05-SCRIPTS-linkedin-engine.js` with its note `00n`, both 30 Sep). Where they disagree,
the Drive files win because they are newer.

This file covers the MCP tools that find and apply to jobs on each platform. The
data tools that already exist (profile, resumes, answers, applications, outcomes)
are described in `CLAUDE.md` and stay as they are unless noted.

**Vocabulary.** *Drafting* builds the apply queue: for LinkedIn, the day's 30 to 40
best jobs. *Applying* works through the queue, or through ids and links given directly.

## Build status (30 Sep 2026)

Built and passing the backend e2e suite (128 checks). The browser engines are checked at
build time (every part parses and stays under 9KB, no undeclared names, every engine
boots in a stub page) and are not yet proven on the live sites: the first live test
(30 Sep) stopped at loading. Engines now reach the page in small parts that the server
hands out on request, never whole (below and section 5).

| Piece | Where |
|---|---|
| Browser engines (LinkedIn draft, LinkedIn apply, Naukri, Wellfound, Indeed) | `src/engines/src/modules/*.js`: one factory per file; shared `core`, `pay` and `res_*` (the answer resolver), then `li_*` (two engines), `nk_*`, `wf_*`, `in_*` |
| Engine build (modules to checksummed parts, checks, hash) | `scripts/build-engines.mjs` -> `src/engines/generated.ts` (committed; `npm run build:engines`, also part of `npm run build`); config parts, the page-state check and the planner of what to send next in `src/engines/index.ts` |
| Engine delivery (issue, `load_engine`, meter, backoffs) | `src/services/engines.ts`, `src/mcp/tools/loadEngine.ts` |
| Per-user engine config | `src/platforms/config.ts` |
| Job ids, platform knowledge, result mapping, envelope, apply lists | `src/platforms/ids.ts`, `knowledge.ts`, `results.ts`, `envelope.ts`, `jobs.ts` |
| Queue, results, backoffs, LinkedIn cap | `src/services/automation.ts` |
| Tools | `start_session`, `end_session`, `resolve_answers`, `load_engine`, `linkedin_draft`, `linkedin_apply`, `naukri_draft`, `naukri_apply`, `naukri_refresh_profile`, `wellfound_draft`, `wellfound_apply`, `indeed_draft`, `indeed_apply`, `queue_jobs`, `report_results`; `check_applied` now returns `new` and `known` |
| Schema | migration `20260930121122_automation_platform_state`: canonical-id CHECK, `applications_queue` index, `platform_state` table |

Where the build differs from the design below:
- **Sessions and answers are built too:** `start_session`, `end_session` and
  `resolve_answers` replace `log_run` and `find_answers` (25 tools). `resolve_answers`
  runs the engines' own resolver on the server (the same built `core` and `res_*`
  parts, instantiated the way the page's boot part does it), so a form filled by hand
  gets the same answers as one an engine fills. `queue_jobs` and `report_results` attach results to the open session's run
  when Claude does not pass `run_id`, so `end_session`'s counts are complete.
- **Onboarding from the resume:** `update_profile` (26th tool) saves profile,
  preferences, work history and education in one call (lists replace the stored ones).
  `start_session` returns `setup_needed`, the facts the scripts need before a first run
  (roles to search, contact, city, years, skills, notice, salaries, max years), and
  tells Claude to propose them from `get_resume` and save what the user confirms. The
  dashboard forms are not needed for a first run. `linkedin_draft` refuses when there
  are no roles to search.
- **Engines are delivered on request, in pieces, never whole.** In the first live test
  (30 Sep) the user's Claude would not send the 36KB LinkedIn script in one browser-tool
  call ("too long for a single execution") and fell back to asking the user to paste it
  into DevTools. The next run (also 30 Sep) got the whole engine in one response as a
  JSON string, had to undo its escaping by hand while copying about 41KB, and a slip made
  a part a SyntaxError. The engine is Aupply's product, so the design is now: a platform
  tool returns steps, an engine id and a tiny `loaded_check`, no engine code; Claude
  reports what its page holds and `load_engine` sends only the next few parts that page
  lacks, as verbatim text blocks (nothing escaped). Section 5 has the protocol.
- **LinkedIn has two engines** so neither receives the other's code: the draft (`core`,
  `pay`, `li_base`, `li_sweep`, `li_screen`, `li_dmain`, about 18KB) and the apply (`core`,
  `pay`, `res_*`, `li_base`, `li_dom`, `li_fill`, `li_job`, `li_main`, about 53KB). A draft followed by an
  apply in the same page only loads what the apply still lacks. The draft config carries
  only the screening rules, the apply config only the answers.
- **One new table after all:** `platform_state` holds rate-limit backoffs
  (`blocked_until` per scope: a platform, or `linkedin_guest` for the guest API) and small
  machine state (Naukri chip, LinkedIn tracker count, Wellfound failure streak). Backoffs
  are a hard constraint, so they get a real table, not `runs.stats`.
- **Uncertain years never drop a job**, and no snippet comes back: Claude reads nothing.
- **Engines carry a config hash** (`h`) next to the engine version (`v`), so a cached copy
  with stale answers is reloaded. Sizes as served (readable, see section 5): LinkedIn apply
  53KB, LinkedIn draft 18KB, the others 41 to 45KB.
- **Naukri's blind "first option" fallback is gone**: an unmatched option ends the chat
  unanswered (Naukri then returns 406 and creates no application). Same for EEO questions
  with no "decline" option on every platform.
- The Naukri and Wellfound apply engines are ports of the 16 Sep Mac copies plus the fixes
  the amendments describe, not of the newer copies in the Claude project "apply".

## Priorities

Set by the user, 30 Sep 2026. Every design choice below is judged in this order.

0. **Never hit a platform's rate limit.** This is a hard constraint, not a trade-off:
   every rate-limit rule in the next section outranks everything else in this document,
   including the daily targets, the queue size, a user asking for more, and speed. When
   in doubt, wait longer.
1. **Automation.** Claude applies end to end with as few human touches as possible.
2. **Accuracy.** Every answer is true to the user's data and settled policies, and every
   recorded status matches what the platform itself shows.
3. **Fewest tokens and the most determinism.** Scripts and server code decide; Claude
   pastes, runs, polls and forwards compact results. Claude never reads a job
   description or a page to make a decision, and any rule that can be code is code.

**Time is not a priority.** The platforms rate-limit, so a slow run that never trips a
limit beats a fast one that does. Aupply's own side should still be as fast as possible
(indexed lookups, batched writes), but the platforms set the pace.

The application dashboard is a nice-to-have. The MCP tools are the product.

## Rate limits

Every limit below was measured in applix. The Aupply rule is at least as conservative
as what the scripts did, usually more, because time is free.

| Where | Measured in applix | Aupply rule |
|---|---|---|
| LinkedIn Easy Apply, per day | About 35 landed, then a "You reached today's Easy Apply limit" dialog. The user's own sessions count too. | Cap 35 by default (`rules.linkedin.daily_cap` can only lower it). Read the tracker before drafting; if today's quota is spent, no LinkedIn run. After `DAILY_LIMIT`, no LinkedIn apply script is issued again that calendar day (user's timezone). One LinkedIn apply run per day. |
| LinkedIn job pages | Cloudflare "Rate Limited" interstitial after about 20 fast loads. The scripts backed off 2 minutes, then used 8s page waits. | The runner waits 6s after each page load and leaves a 15 to 30s gap between jobs (the scripts used 4s). On the interstitial: stop, wait 5 minutes, resume with 8s page waits for the rest of the run. A second interstitial ends LinkedIn for the run. |
| LinkedIn guest search API | No trouble at 150 to 180ms apart. | One request per second. |
| LinkedIn guest JD API | 3-wide parallel fetching got HTTP 429 with empty bodies on 92 of 95. One worker at 700ms did 57 with zero 429s. Recovers in about 5 minutes. | One worker, 1.5s apart. An empty body counts as a 429. Stop at the first one, wait 10 minutes, resume skipping ids already done. A second 429 ends the prescreen for the run; what survived so far is queued. |
| LinkedIn, general | Two loops or two tabs at once caused 429s and throttled timers. | One loop at a time per page: sweep, prescreen and runner never overlap. No second tab while a runner is live. No second session on the same browser (`start_session` reports `another_run_live` and LinkedIn is refused). |
| Naukri search API | `/jobapi/v3/search` answers "recaptcha required". | Never used; search result pages only. |
| Naukri apply | No limit measured. | One job at a time, a 15 to 30s gap between jobs, a 406 retried once and never more. |
| Wellfound | A run of NO_MODAL after a burst of successes is a session throttle; opening a new tab does not help. | Two NO_MODALs in a row (each after its one retry) stop Wellfound for the run. At most three calls per job. |
| Indeed connector (Claude's own connector, not Aupply's) | A 13-wide `get_job_details` batch tripped an account-level limiter whose backoff grew instead of draining. It has also returned `-32429` errors. | `indeed_draft` tells Claude: serial calls only, 20s apart; on `-32429`, stop using the connector for the run. |
| Indeed apply | The review page carries a reCAPTCHA. | Never touched. The tab is parked for the user. |

**How the rules are enforced, so they do not depend on Claude remembering them:**
- Pacing constants live inside the engines. No tool input can shorten them.
- Backoffs and caps live on the server. `report_results` records every rate-limit sign
  with a `retry_after`; until then the platform's draft and apply tools refuse to issue
  a script and say when to come back, and `start_session` shows `blocked_until` per
  platform.
- On any rate-limit sign an engine stops and reports. It never retries beyond the
  backoff defined here.

---

## 1. What the scripts do

| | Draft (find and screen) | Apply | Verify | Hard limits |
|---|---|---|---|---|
| **LinkedIn** | Guest search API (`jobs-guest/.../seeMoreJobPostings/search`), keywords x pages, `f_AL=true`, last hour then last 24h. Title filter (`__filt`: spam companies dropped, job-ad networks last, last-hour postings first). JD prescreen through the guest `jobPosting/<id>` API (`__pre2`: one worker, 700ms, stops on the first 429). | Engine pasted once on `/jobs-tracker/`, then `__runQ` moves between jobs by SPA navigation. Never loaded with `eval`: the page's CSP blocks it on job pages, and on the tracker page after the first load. | Tracker count (`Applied · n`) every 10 to 15 jobs. SENT / UNCONFIRMED is not proof. | About 35 landed per day. Never older than 24h. Cloudflare "Rate Limited" after about 20 fast page loads. Guest API returns 429 with empty bodies under parallel load and recovers in about 5 minutes. |
| **Naukri** | Search page by URL slug (`?experience=1&jobAge=1`), scrape `.srp-jobtuple-wrapper`, filter pay, title, spam and always-external companies. Ids with `50` at digits 7 and 8 are external. | One click or chatbot. Hide Simplify, never dismiss it. Untick "Follow". | The redirect code: `200` applied, `406` nothing created, retry once for free. | Clicking Apply submits, and chatbot answers submit as typed: there is no review step. |
| **Naukri profile** | | Toggle one key-skill chip every run so "Profile last updated" reads Today. Needs real mouse clicks. | The timestamp. | |
| **Wellfound** | Role slug listing pages (5 scrolls, page 2). Cards give id, slugged URL, years, pay. Screen the URL slug too. | Two calls per job: `__hit` (checks, clicks Apply), then `__fin` (modal, screening form, cover note, location block, Send). | Send button gone, `✓ Applied` on the job page. | Dedup by **company**: a second job at a company already applied to never opens its modal. NO_MODAL has four causes; at most three calls per job. |
| **Indeed** | Browser sweep, the Indeed connector (titles unreliable, ids change per call), or Indeed alert emails (stable `jk`). | Drive the wizard across two origins to `review-module` and stop at the reCAPTCHA, tab left open. **Always a handoff.** 6 of 6 parked tabs were submitted by the user. | Mail from `indeedapply@indeed.com`: "Your application has been submitted". | Never touch the CAPTCHA, never close a parked tab. |
| **External ATS** | Greenhouse, Lever, Ashby, Workday reached from other sites. | Retired: 1 completable application in 212 swept, 14 calls each. Logged as a lead, never worked. | | |

Result codes, as the scripts return them:

- LinkedIn engine (`__job`): `SENT`, `UNCONFIRMED`, `NEEDS_INPUT`, `STALL`, `NO_BUTTON`, `FOLLOW_STUCK`, `NO_MODAL`, `NO_EASY_APPLY`, `CLOSED`, `DAILY_LIMIT`. The runner (`__runQ`) adds `TITLE_MISMATCH`, `RATE_LIMITED`, `ERR`.
- LinkedIn prescreen (`__pre2`): `keep`, `CLOSED`, `DROP_ATS:<name>`, `DROP_REACT_NATIVE`, `DROP_YEARS`, `DROP_MIDSENIOR_NOYEARS`, `RATE_LIMITED`, `HTTP_<code>`, `ERR`.
- Naukri: `APPLIED` (200), `REJECTED` (406), `ALREADY`, `EXTERNAL`, `NO_APPLY_BUTTON`, `NO_ANSWERABLE_QUESTION`, `CLICK_FAILED`, `MAX_STEPS`
- Wellfound: `ALREADY`, `SKIP_<n>YRS`, `SKIP_LOWPAY`, `NO_APPLY`, `SENT`, `NEEDS_INPUT`, `UNCONF`, `NO_MODAL`, `NO_SEND`, `BLOCKED_LOC`
- Indeed: `NAVIGATED`, `READY_FOR_CAPTCHA`, `READY_TO_SUBMIT`, `NEEDS_DROPDOWN`, `NEEDS_INPUT`, `NO_INDEED_APPLY`, `ALREADY`, `STUCK`

## 2. What went wrong in applix that this design must not repeat

- **Engine copies drifted.** The Mac, Drive, the Claude project and each site's
  `localStorage` cache disagreed: the docs said 15L expected while the caches said
  10L, the Naukri cache still preferred "Immediate" for notice, and the 27 Sep
  LinkedIn engine did not parse.
- **Four resolvers, patched live as wrapper chains** (`__A0 → __Av1 → ... → __A`). The
  v2 and v3 patches reused names and silently deleted each other's rules, including
  the one that stops a "former employee" claim.
- **Personal values lived in the engines.** The 30 Sep LinkedIn file still hardcodes
  the phone number, CTC, school and city, and the stack regex (`NEGS`) is one person's
  stack; another user needs the opposite.
- **Decision rules lived in prose.** Retry a 406 once, the NO_MODAL rule, the cap,
  the recency rule, dedup by company. Every run re-read 13 or more documents to learn them.
- **State lived in logs.** Which way to toggle the Naukri chip, what had already been
  screened, what was parked. Runs undercounted their own results twice.

## 3. Decisions

**D1. Scripts run in the user's browser, through Claude's browser tool. Aupply's
servers never contact a job site.** The session and login live in the user's
browser; a shared server IP would be blocked within days; and the traffic stays the
user's own action on the user's own account. Aupply serves the scripts, screens,
decides and remembers. **There is no Aupply browser extension** (settled 30 Sep):
Aupply gives the user's own Claude the scripts and instructions, and Claude does the
work.

**D2. One tool per platform per action for anything that touches a site; shared
tools for anything that only touches Aupply data.** Inputs genuinely differ per
platform (LinkedIn takes a numeric id, Wellfound needs the slugged URL because a
bare id 404s, Naukri searches by slug + experience + job age, Indeed by `jk`), and
each response carries that site's run protocol.

**D3. Drafting builds the queue; applying works through it.** A LinkedIn draft is the
day's 30 to 40 best jobs: the cap is about 35 landed, and a few always turn out closed
or not Easy Apply. The apply tools submit; there is no fill-without-submit mode.
Indeed is the exception by nature: its apply stops at the reCAPTCHA and hands the tab
to the user.

**D4. Apply tools take job ids or links, in any mix, or `from_queue: true` for the
drafted queue, best first, within the cap.** No separate "apply all" tool.

**D5. The queue is `applications` rows with status `discovered`**, which is already
the column default. Recency becomes a query filter, so a stale LinkedIn queue cannot
be applied to.

**D6. Screening rules are compiled from the user's preferences plus platform
knowledge.** The same module runs in the page during a draft (so hundreds of cards
and JDs never pass through Claude's context) and on the server for jobs found any
other way.

**D7. One answer registry, shared by every engine and by `resolve_answers`.**
Engines carry the user's answer pack; what they cannot answer comes back as
`NEEDS_INPUT`.

**D8. Engines report raw results; `report_results` maps them to statuses and applies
the retry and stop rules.** Every tool response ends with `next`, so Claude follows
the server instead of carrying the runbook.

**D9. Engines are built in this repo** (plain JavaScript modules, one factory each,
built into small parts that check their own checksum), versioned by content hash, and
self-test when loaded.

**D10. Technology questions are settled at draft time.** While drafting, jobs whose
JD names a main technology the user doesn't list go to the user in one batch to keep
or drop. Inside an application, every technology or stack question is answered Yes
(settled 30 Sep, section 7).

**D11. Every job Aupply touches is one row keyed by `(user_id, platform, canonical job
id)`, and a draft checks that index before spending anything on a job** (section 9,
"Job identity and dedup"). LinkedIn drafts collect Easy Apply jobs only.

---

## 4. Tool catalog

| Tool | Kind | Replaces |
|---|---|---|
| `start_session` | write (opens a run) | `log_run` (open), "call get_pending_actions first" |
| `end_session` | write | `log_run` (ended) |
| `check_applied` | read | (kept, with canonical ids) |
| `queue_jobs` | write | |
| `report_results` | write | `log_application` for engine runs (it stays for manual ones) |
| `resolve_answers` | read | `find_answers` |
| `linkedin_draft` | read | |
| `linkedin_apply` | open world | |
| `naukri_draft` | read | |
| `naukri_apply` | open world | |
| `naukri_refresh_profile` | open world | |
| `wellfound_draft` | read | |
| `wellfound_apply` | open world | |
| `indeed_draft` | read | |
| `indeed_apply` | open world | |

Kept as they are: `get_candidate_profile`, `get_preferences`, `get_resume`,
`save_answer`, `log_application` (manual and external flows), `get_application_history`,
`get_application_stats`, `get_pending_actions`, `record_outcome`, `complete_action`.
Added in the build: `update_profile`. That makes 26 tools.

"Open world" tools return a script that acts on a job site when Claude runs it. They
are annotated `readOnlyHint: false, openWorldHint: true` so clients treat them as
consequential. Draft tools only return a script that reads (storing the queue is
`queue_jobs`), so they are read-only.

### Shared tools

**`start_session`**
- Input: `client?`, `platforms?` (default `preferences.platforms`).
- Returns: `run_id`; `pending_actions` (waiting on the user, soonest deadline first);
  `reconcile` (parked and unconfirmed jobs and how to confirm each: Indeed by asking the
  user which they submitted, LinkedIn unconfirmed by the tracker); per-platform state (LinkedIn
  `applied_today` and `cap_left`, Naukri `refresh_due` and last chip state, Indeed
  `parked`, and `blocked_until` for any platform in a rate-limit backoff);
  `another_run_live` when a run started under two hours ago and never ended;
  `provisional_answers` to confirm with the user when convenient.
- Enforces: pending actions before new applications. Warns about overlapping runs
  (on 28 Sep two runs on one Chrome undid each other's Naukri toggle).

**`end_session`**
- Input: `run_id`, `summary?`, `hurdles?`.
- Returns: counts per platform and status for the run, computed from `applications`
  rather than Claude's tally; provisional answers used in the run and which companies
  saw them; a 30-day funnel (applied, acknowledged, assessment, interview, rejected)
  for the honest read the user asked for.

**`check_applied`** (exists; changes)
- Input: `platform`, `external_ids[]` (any form: ids, URLs, URNs), `companies?`.
- Returns: `new` (canonical ids Aupply has never seen for this user and platform) and
  `known` (canonical id → status), plus company matches for Wellfound.
- Canonicalises every id first (section 9), then one index lookup. This is the draft's
  "already applied?" step, run before anything costly such as a JD fetch.

**`queue_jobs`**
- Input: `platform`, `run_id?`, `source` (`sweep`, `alert_email`, `connector`, `link`,
  `manual`), `jobs[]` (as the draft script returned them, or as found elsewhere: id or
  URL, title, company, location, pay text, years, posted, seniority level, JD, stack
  found), `skipped[]` (id + reason code from an in-page draft), `decisions?`
  (`[{ ref, keep }]`: the user's answers to an earlier `ask_user`).
- Returns: `queued`, ranked (ref, title, company, score, flags such as `needs_jd` and
  `years_waiver`); `ask_user` (jobs whose JD names a main technology the user doesn't
  list, each with what it wants and what the user has, to ask in one batch); skip
  counts by reason; duplicates; `next`.
- Enforces: canonical ids (section 9); refuses ids that are not stable (Indeed
  `JOBSEARCH_nn`, `to.indeed.com` links); dedup by job id, and by company on Wellfound;
  recency; full screening for anything that did not come from an in-page draft;
  ranking, with job-ad networks such as Joveo, Jobgether and SecondWind last.
  Survivors are written as `discovered`, rejects as `skipped` with a reason code, so no
  later run screens them again. Jobs in `ask_user` stay out of `from_queue` until
  decided; `keep: false` records them as skipped (`stack_declined`). Claude can start
  applying the rest while the user answers.

**`report_results`**
- Input: `platform`, `run_id?`, `results[]` exactly as the engine's `status()` returned
  them, `tracker?` (`{ before, after }`).
- Returns: the recorded status and reason per job; `next` (retry and how, which
  questions to ask the user, skip, stop the platform and until when, read the tracker
  now); `cap_left`; `retry_after` when a rate-limit sign was reported.
- Enforces: the mapping in section 6; retry counters kept on the row
  (`metadata.attempts`); `DAILY_LIMIT` closes LinkedIn for the day; `RATE_LIMITED` backs
  off; the Wellfound NO_MODAL rule, judged against this run's recent results; tracker
  reconciliation (when the tracker moved less than SENT + UNCONFIRMED, the UNCONFIRMED
  jobs whose trace repeated one page are marked failed). Screening questions go to
  `application_questions`. Idempotent on an attempt id the engine generates.

**`resolve_answers`**
- Input: `questions[]` of `{ q, options?, field?, company? }`, up to 50.
- Returns per question: `answer`; `option` (which one to pick when options were
  given); `source` (`registry:<key>`, `saved`, `history`, `none`); `status`
  (`confirmed`, `provisional`, `unknown`, `protected`); `answer_id`.
- `protected` is a never-invent fact with no value: skip the job or ask, never guess.
  `unknown`: ask the user and save the reply with `save_answer`.
- Uses the same registry as the engines, so a form Claude fills by hand gets the same
  answers as one an engine fills, including Yes to technology questions.

### LinkedIn

**`linkedin_draft`** (read-only). **Easy Apply jobs only.**
- Input: `windows?` (`1h`, `24h`; default both, in that order; nothing older unless the
  user raised `max_posting_age_hours`), `keywords?` (default `desired_roles`, plus
  junior and associate variants when the user is junior; the applix set also adds
  LLM Engineer and Generative AI Engineer), `target?` (default 40), `location?`.
- Returns the envelope (section 5). Open `/jobs-tracker/?stage=applied` and read the
  Applied count first: if the user's own session already spent today's quota, `next`
  says skip LinkedIn. Then three steps in one page lifetime:
  1. `__aupply.sweep({ windows })`, detached and polled: guest search API with
     `f_AL=true` (the Easy Apply filter, so nothing else enters), one request per second, parsed by
     regex because Trusted Types blocks `DOMParser`, then the title filter. Returns the
     candidates' job ids.
  2. `check_applied({ platform: "linkedin", external_ids })`: one index lookup drops every
     job Aupply already knows for this user.
  3. `__aupply.prescreen(newIds, { target })`, detached and polled: JD fetch through the
     guest `jobPosting/<id>` API with one worker, 1.5s apart, under the JD API rule in
     Rate limits; years from the **first** match (decimals handled: "2.5-5 years" is
     2.5), skipping matches that look like a recruiter byline ("25+ yrs in Tech") or have
     no "experience" nearby; a snippet comes back only when the match is still uncertain,
     so in the normal case Claude reads nothing; drops closed
     postings, non-LinkedIn ATS (`applicantTrackingSystemName`), jobs over the years
     limit, and Mid-Senior, Director or Executive with no years stated; stack check
     against the user's skills. Stops early once `target` jobs survive.

  Then `queue_jobs` with `source: "sweep"`: survivors become the queue, prescreen rejects
  are stored as skipped so no later draft fetches their JD again.
- The draft has its own small engine (`linkedin_draft`): it never receives the apply
  code (the form filler and the resolver). An apply in the same page afterwards loads only
  the modules the draft engine did not bring.

**`linkedin_apply`**
- Input: `jobs?` (ids or URLs), `from_queue?`, `limit?`, `answers?` (question → answer
  overrides after a `NEEDS_INPUT`).
- Open the tracker page (or stay on it after a draft); load the apply engine (what the
  page already holds is not sent again); run the `run` block, which is
  `__aupply.runQueue([[id, company], ...], {k: <checksum>})`: a separate verbatim block
  whose checksum makes the page refuse a queue that was mistyped in transit (a wrong job
  id would apply to the wrong job). The runner moves
  between jobs by SPA navigation, checks the page title names the company before
  applying (`TITLE_MISMATCH` otherwise), discards a stalled modal and moves on, stops
  on `DAILY_LIMIT`, follows the LinkedIn job-page rule in Rate limits, and reads the
  tracker count before, after, and every 10 jobs. Poll with
  `await __aupply.wait(35000)`, which returns as soon as a job finishes (or after 35s)
  with only the results since the last poll. Call `report_results` every 5 finished
  jobs, on any stop code, and at the end. Results are also kept in the page's
  `localStorage`, so nothing is lost if the session dies. About 2 minutes per job with
  the gap.
- Enforces before returning: the daily cap (default 35, `rules.linkedin.daily_cap`),
  trimming the list and saying so; drops jobs already applied to; drops postings whose
  URL names a non-LinkedIn `applicantTrackingSystemName` (external anyway, and the case
  that tripped Claude's permission check on 28 Sep); refuses queued jobs older than 24h
  and jobs still waiting on a stack decision. A job given by id that turns out not to be
  Easy Apply is skipped; LinkedIn is Easy Apply only.
- Handoffs, each followed by `__aupply.resume()`:
  - `NEEDS_CLICK` for city typeaheads ("Enter city or location" on PyjamaHR and
    Greenhouse-backed forms): the engine returns the element's rect and `innerWidth`;
    Claude clears the input, types the city and makes a real click on the suggestion
    (scaling by screenshot width over `innerWidth`).
  - `FOLLOW_STUCK`: the pre-ticked "Follow <company>" box would not untick from script;
    Claude makes a real click on it and reads `checked` back.

### Naukri

**`naukri_draft`** (read-only)
- Input: `slugs?` (default from `desired_roles`), `experience?` (default the user's
  years, and one more), `job_age_days?` (default 1), `pages?`.
- Returns the search URLs to visit in order (keyword in the slug, never `?k=`, or the
  filters silently drop), the scraper, `__aupply.scrape()` per page, then `queue_jobs`.
  At `jobAge=1` the slug barely matters (every slug returned the same 31 jobs on
  28 Sep), so the server builds few slugs and two experience levels. Expect 2 to 4
  applyable jobs a day.
- In the page: pay floor across `X-Y Lacs PA`, `N /month` and ranges; word-bounded
  negatives (`lead` otherwise eats Naukri's "Leading Client"); spam and always-external
  company lists; ids with `50` at digits 7 and 8 marked external. Never the `/jobapi`
  endpoint (it demands a reCAPTCHA).

**`naukri_apply`**
- Input: `jobs?` (ids or URLs), `from_queue?`, `limit?`.
- Per job: open `naukri.com/job-listings-x-y-<id>` (resolves any id); load the engine once, then
  `loaded_check` re-loads it from `localStorage` on later pages; run `__aupply.go()` detached (polls 13s for
  the Apply control and branches on its label, hides Simplify, unticks Follow, runs the
  chatbot with the repeated-question guard); a few seconds later read
  `__aupply.result()`, which parses the redirect code in the page and returns only the
  code.
- Enforces: the Naukri apply rule in Rate limits (one job at a time, 15 to 30s apart); a
  406 gets one free retry and no more. A chatbot with an academic ladder (10th, 12th,
  UG) is skipped until the "read the newest chat bubble" fix lands, because the current
  engine can re-send the previous answer to a question without a `?`.

**`naukri_refresh_profile`**
- Input: nothing, to get the steps; `result: { chip, action, last_updated }` to record.
- Returns: the profile URL; the chip (`rules.naukri.refresh_skill`, otherwise the first
  suggested chip); the direction the last run implies, as a hint only ("read the chip,
  not the log"); the steps: hide Simplify, JS-click `.keySkills .edit.icon`, read the
  chips (`<name>Cross` means it is on the profile), **real** mouse click on the chip or
  its close icon (JS clicks do nothing there), Save, check `Profile last updated - Today`.
  Never type into "Add skills"; it drops the last character.
- `start_session` reports it as due when it has not run today.

### Wellfound

**`wellfound_draft`** (read-only)
- Input: `role_slugs?` (mapped from `desired_roles` onto Wellfound's slug list),
  `pages?` (1 or 2), `location?`.
- Returns listing URLs, the scraper (cached in `sessionStorage`; `localStorage` reads
  back empty on Wellfound), `__aupply.scrape()` per page (5 scrolls; more trips the 45s
  limit), then `queue_jobs`.
- In the page: screens the URL slug as well as the title, the pay band floor, and years.
  On the server: ids under about 3.5M are flagged as probably years old.

**`wellfound_apply`**
- Input: `jobs?` (full slugged URLs; a bare id is resolved from stored rows or refused),
  `from_queue?`, `cover_note?` (default the saved `cover_note` answer).
- Two calls per job: `__aupply.hit()`, then `__aupply.fin()` detached and polled. The
  engine carries the companies already applied to and returns `DUPLICATE_COMPANY`
  from the page title before clicking anything. When the tab is hidden (someone else is
  using that Chrome window), interleave small screenshots while polling so the modal's
  timers keep running.
- Enforces: the Wellfound rule in Rate limits (two NO_MODALs in a row, each after its
  retry, stop Wellfound for the run) and at most three calls per job; on-site "Relocation Not
  Allowed" jobs outside the user's city are skipped before Apply.

### Indeed

**`indeed_draft`** (read-only)
- Input: `query?`, `locations?`, `fromage?` (default 1).
- Returns search URLs (`fromage=1&sort=date`), the scraper (dedup by `jk`, the "Easily
  apply" flag, pay), then `queue_jobs`. The response also carries the rules for other
  sources: the Indeed connector takes serial calls only, 20s apart (Rate limits);
  connector titles are unreliable and its ids change on every call, so read the
  JD before accepting or rejecting and remember company + title, never the id; alert
  emails carry stable `jk`s; the two pools join on company, not id.

**`indeed_apply`**
- Input: `jobs` (`jk`s or URLs), `from_queue?`. Always parks.
- Per job, in its own tab: open `in.indeed.com/viewjob?jk=<jk>`, load the engine, `__aupply.drive()`
  → `NAVIGATED`; load it again on `smartapply.indeed.com` (its own origin), `drive()` →
  `READY_FOR_CAPTCHA`.
  Status `parked`. Hand the user one list at the end, never one tab at a time, and never
  close a parked tab. `NEEDS_DROPDOWN` is a real-click handoff.
- The user submits the CAPTCHA themselves; `start_session` lists the parked Indeed jobs and Claude asks which they sent.

---

## 5. The envelope every platform tool returns, and how the engine reaches the page

The engine is Aupply's product, so the server decides what Claude receives and when. A
platform tool returns the steps and the id of an engine, never the engine. Claude gets
engine code only from `load_engine`, a few parts at a time, and only what its page lacks.

```json
{
  "engine": "linkedin_draft@62e057d5dd.412f81f4",
  "open": "https://www.linkedin.com/jobs-tracker/?stage=applied",
  "steps": ["Open ...", "Load the engine (load_rule). ...", "Run __aupply.sweep() ...", "..."],
  "rules": ["Stay on this page: a real navigation wipes the sweep. ..."],
  "load_rule": "Load the engine into this page with load_engine, never by hand. (1) Run the loaded_check block ..."
}
```

followed by text blocks, each its own block of the tool result, verbatim (nothing escaped):
`/*aupply loaded_check*/ (()=>{...})()` (about 200 to 350 characters) and, for
`linkedin_apply`, `/*aupply run*/ __aupply.runQueue([...],{k:...})`.

The loading protocol:

1. Claude opens the page and runs the `loaded_check` block in it. It answers `ok` when this
   exact engine (version and config) is live, re-loading it from the page's own cache first
   on the platforms that allow `eval` (Naukri, Wellfound, Indeed). Otherwise it answers
   the page's state: `[{module: hash, ...}, config tag, engine tag]`. It reveals nothing
   about the engine.
2. Claude calls `load_engine` with `engine` and `page` = that answer. The server plans from
   the state (`planLoad` in `src/engines/index.ts`): the modules the page lacks, by hash;
   then the rest of the user's config; then the boot part. It sends at most 12KB of module
   code per answer (32KB with config and boot), and never every module of an engine in one
   answer, each part as its own text block labelled `/*aupply <engine>@<version> <part>*/`.
3. Claude runs each block as its own JavaScript call, in order, and every part answers with
   the page's state again. Claude calls `load_engine` again with the last answer and repeats
   until the boot part answers `{ok:true,...}` or `load_engine` answers `ready`.
4. A page that already holds an engine's modules is sent nothing for them: a second draft
   with new answers gets only the config and the boot part, and an apply after a draft in
   the same page gets only the apply modules.

What guards the engine (the code still reaches the user's Claude and browser when it is
used, so this limits exposure, it cannot hide the code):
- Never whole: no answer carries all of an engine, nothing is sent the page has, and a
  platform tool response carries no engine code. A user who only applies never receives
  the draft code (LinkedIn), and the reverse.
- Issued, not free: a platform tool stores the user's config for the engine
  (`platform_state`, scope `engine_<name>`, one row per user overwritten by the next issue,
  valid 8 hours); `load_engine` serves only that, for the user in the token.
- Metered: per user, engine and day at most `DAY_LOADS` (6) times the engine's size is
  delivered, then `load_engine` answers `limit` and Claude is told to stop. A retry or a
  reloaded page costs a part of one load. Every delivery is logged (user prefix, engine,
  parts, bytes).
- Backoffs apply: no part is sent for a platform in a rate-limit backoff.
- Claude is told never to show, quote or explain the code, to load it only by these
  calls, and never to apply by hand or ask the user to paste it.

Rules every engine follows, from the browser tool's limits:

- **Parts are small and no part is sent as a JSON string.** A browser tool would not take
  a 36KB script in one call (30 Sep), and code inside a JSON string arrives escaped (every
  quote and backslash doubled, three times over for a config inside a script), which
  Claude has to undo while copying: one slip is a SyntaxError that no checksum can catch.
  So parts are text blocks of their own. The build fails any part over 9KB. The user's
  config is not a JSON string inside JavaScript either: config parts build a plain object
  (`window.__apc`) statement by statement, and a large config spans several answers.
- **A part changed in transit refuses to load.** Every part, modules and config alike,
  checks its function's checksum before doing anything, so a mistyped character answers
  `corrupt part ...` (copy that block again) instead of misbehaving on a form. The boot
  part checks the whole config object against a checksum set by the last config part, so
  a config part skipped, repeated or out of order cannot boot (a config part also answers
  `config N needs config N-1 first`). A part with a syntax error never runs at all: the
  load rule tells Claude to copy that one block again, and to stop after 3 failures and
  report the exact error. It is never to apply by hand, run the code elsewhere or ask the
  user to paste it.
- **Anything Claude must copy and that has consequences travels as a verbatim block with a
  checksum.** The LinkedIn queue (job ids) is one: `runQueue` answers `CORRUPT_QUEUE`
  instead of applying to a job id that was mistyped.
- **Never `eval` on LinkedIn.** The browser tool runs a pasted part outside the page's
  CSP, so pasting always works. LinkedIn refuses `eval` and `new Function` on job pages,
  and on the tracker page after the first load (30 Sep), so LinkedIn never uses a cache.
  Naukri, Wellfound and Indeed allow `eval`: there the boot part caches the whole engine
  in page storage and `loaded_check` re-loads it in the same call, with no server call.
- **Loading is Claude's job.** The load rule and the server instructions say so: never
  ask the user to paste code or open DevTools; if the browser tool cannot run
  JavaScript, say so and stop.
- **Readable code, on purpose.** Claude copies every part with its own hands, and dense
  minified code is what it mis-copies (30 Sep: a ternary that lost its else branch, an
  ending that jumped to an earlier similar spot, both a syntax error that no checksum
  can report). Parts are real names and one statement per line, about 19% more tokens
  than minified by a rough estimate, for far fewer copy errors. A part's checksum ignores
  line edges and blank lines, so whitespace that changes in transit does not matter.
  Served code never contains a `\uXXXX` escape (the build fails on one): a copier turns an
  escape into the glyph or a straight quote, which passes the parser and fails the checksum
  the same way every time (30 Sep: `res_rules_b`, a curly apostrophe, three failed loads).
- **`wait` is event-driven, at most 35s.** It answers at once when nothing runs, wakes on a
  result or when the run stops, and otherwise on one timer: a loop of one-second sleeps
  adds a throttled tab's delay to every tick (30 Sep: 10s waits answered, 20s and longer
  timed out at the tool's 45s). A status carries `hid:1` when the tab is hidden, and the
  LinkedIn runner waits for the tab to be shown before each job: Chrome throttles the
  timers of a hidden tab and LinkedIn's modal stalls in it.
- **No answer longer than 900 characters.** The Chrome extension cuts a JavaScript answer
  at exactly 1000 characters (1 Oct: the sweep's 66 ids and the prescreen's drops came back
  cut off, so they could not be passed on as-is). `core` caps every status answer
  (`ANSWER_MAX`), trims a result to `ITEM_MAX` (its longest list loses entries, `cut:1`),
  and hands out only the results that fit, with `more:N` for the rest; Claude calls
  `status()` again until `more` is gone. The sweep and the prescreen push their lists in
  chunks and end with a `done:1` summary. The build checks that no answer passes 1000.
- **No call blocks longer than about 35s.** The browser tool times out at 45s, so longer
  work runs detached and is polled.
- **`status()` and `wait()` return compact JSON with job ids only, and only what changed
  since the last call**: no URLs and no query strings, because the Chrome extension
  blocks tool output that looks like one.
- **Tokens.** A long run's cost is mostly turns, because every tool call re-reads the
  conversation. So polls block as long as the browser tool allows and return only new
  results, reports are batched, the payload is minified, static rules live in tool
  descriptions rather than every response, and nothing sends Claude a page or a job
  description to read.
- **Self-test on load.** The boot runs the resolver's rules on built-in fixtures and
  returns `{ ok, v, h, fails }`. It tests the rules alone: a saved answer to a fixture
  question ("What is your notice period?") once made a healthy engine report a failure.
- Scripts carry the user's answer pack but **never an Aupply token**.

## 6. Result mapping

| Engine result | Platforms | Status | Next |
|---|---|---|---|
| `SENT`, `200` | LinkedIn, Naukri, Wellfound | `applied` | continue |
| `UNCONFIRMED`, `UNCONF` | LinkedIn, Wellfound | `unconfirmed` | tracker or job page reconciles |
| `ALREADY_APPLIED`, `ALREADY` | all | `applied` (noted as outside Aupply if new) | continue |
| `NEEDS_INPUT` | LinkedIn, Wellfound, Indeed | unchanged; questions logged | `resolve_answers`, ask the user, re-run with `answers` |
| `READY_FOR_CAPTCHA` | Indeed | `parked` | tell the user; ask which they sent |
| `CLOSED` | LinkedIn | `closed` | never retry |
| `EXTERNAL`, `NO_INDEED_APPLY` | Naukri, Indeed | `lead` | log only |
| `NO_EASY_APPLY` | LinkedIn | `skipped` | LinkedIn is Easy Apply only; no lead is logged |
| `SKIP_<n>YRS`, `SKIP_LOWPAY`, `DUPLICATE_COMPANY`, relocation | Wellfound | `skipped` with reason | |
| protected fact required, no honest option | all | `skipped` | list in the summary |
| `406` | Naukri | first: unchanged; second: `failed` | retry once |
| `NO_MODAL` | LinkedIn, Wellfound | first: unchanged; then `failed` (isolated) or stop Wellfound (a run of them) | retry once |
| `STALL`, `NO_BUTTON` | LinkedIn | unchanged, then `failed` | the runner already discarded the modal; screenshot to find the hidden required field before a retry |
| `TITLE_MISMATCH` | LinkedIn | unchanged | re-queue once; the job page did not load |
| `NEEDS_CLICK`, `FOLLOW_STUCK`, `NEEDS_DROPDOWN` | LinkedIn, Indeed | unchanged | real click, then resume |
| `ERR` | all | unchanged, then `failed` | retry once |
| `DAILY_LIMIT` | LinkedIn | job unchanged | stop LinkedIn for the day |
| `RATE_LIMITED` | LinkedIn | unchanged | the Rate limits rule for that endpoint: pause, then slower; a second one stops the platform for the run |

## 7. Answer registry

The resolver modules (`res_base`, `res_rules_a`, `res_rules_b`, `res_api` in
`src/engines/src/modules`) are one ordered list of canonical question keys, loaded by
every engine and by `resolve_answers`. Each entry
holds its matching patterns, where the value comes from (a profile field, the user's
saved answer with that key, or a universal rule), the value type and unit conversions,
how to pick an option, and whether it may ever be inferred.

| Group | Keys (examples) |
|---|---|
| identity | `name.first`, `name.full`, `email`, `phone`, `location.city`, `links.linkedin`, `links.github`, `pronouns` |
| experience | `experience.years` (banded), `experience.months` (12; "additional months" is 0), `experience.tech` (policy below), `experience.projects_shipped`, `experience.users_served` |
| employment | `employment.current_company`, `employment.current_title` (text and dropdown) |
| compensation | `comp.current`, `comp.expected`: rupees, lakhs or LPA read from the label; a banded dropdown picks the band that contains the value |
| availability | `notice.days` (bands; "Immediate" only when true), `start.earliest_date`, `start.immediately`, `shifts` |
| location | `location.based_in` (truthful: "based in X, willing to relocate to Y"), open city questions ("Which city are you located in?") answer the city, `relocate`, `preferred_locations`; inline numbered options return the number |
| eligibility | `work_auth.home`, `sponsorship.home`, `sponsorship.us`, `passport` |
| education | `education.degree`, `.major`, `.school`, `.dates`, `.grade`, `.grade_12`, `.grade_10` |
| history | `former_employee` (No), `referred` (No), `non_compete` (No) |
| long form | `pitch.summary`, `cover_note`, `why_seeking`, `skills_text`, `projects_text` |
| universal, no user value | source ("how did you hear": the platform's name), EEO (decline), privacy consent (tick), marketing and "follow company" (never tick), English proficiency, graded scales (second positive option; when several start with "Yes", the last) |

**Protected keys** are never inferred, and a required one with no value skips the job:
references, government ids, date of birth, full address or postal code, marks and GPA,
employment dates, job titles, employer names, salary figures, certification ids,
family members' names.

**Resolution order:** protected check → saved answer by key → profile field → universal
rule → technology policy → exact match on a saved ad-hoc answer → `NEEDS_INPUT`.

**Ordering hazards.** Each of these cost a failed or wrong application in applix, and
each becomes a test:
- normalise `exp` to experience and `yrs` to years before anything else
- "experience in <tech>" before total experience
- "worked for / employed by <company>" before "have you worked with X"
- "how many months" and "how much experience" before any yes/no rule
- "how many projects / users" before years
- open city questions before "are you currently located in <city>" (the second is Yes/No)
- a numeric field never receives "Yes"; repair from the form's validation message
- catch-alls last

The test corpus is every question quoted in the applix scripts and amendments, with its
expected key and answer.

**Technology policy** (settled 30 Sep). Any "do you have experience with X", "how many
years of X" or stack question, inside any application (engine or by hand):
- Yes, and the user's headline years (1 year for applix) for "how many years". Never
  No, never 0. This is the applix rule from 27 Sep: a No costs the job, a Yes costs
  nothing.
- A saved answer for that technology always wins over the policy.
- The policy covers technology and stack only. Facts keep their own rules: "worked
  for <company>" is No, sponsorship follows the saved answers, protected keys are never
  inferred. Three facts that got the blanket Yes in the first live run (1 Oct): a total
  experience threshold ("Do you have 2+ years of software development experience?") is
  answered from the user's years; "worked with <the employer>" is the former-employee
  question (the engine passes the employer's name to `R.A`); a driver's license, vehicle
  or laptop is asked, never assumed.
- LinkedIn's years fields take whole numbers only ("Invalid input" for 0.5, 1 Oct): the
  form filler rounds years to the nearest whole number, and `repair()` rounds any decimal
  a numeric field refuses.
- The asking happens earlier, at draft time (section 8, stack check), which is where
  the user decides whether a job outside their stack is worth applying to at all.

`rules.tech_questions = "skills"` is available for a user who wants strict answers
(Yes only for technologies in their skills, otherwise `NEEDS_INPUT`).

## 8. Screening

Compiled per request from preferences and platform knowledge
(`src/platforms/<platform>/knowledge.ts`: spam companies, always-external companies,
job-ad networks, slugs, location ids).

- **Titles:** seniority negatives from `seniority_levels`; intern, internship, trainee,
  fresher and "fresh graduates" unless internships are wanted; years in the title,
  including `yoe`.
- **Stack in the title:** `exclude_keywords` compiled with safe boundaries (`\.net` takes
  no leading `\b`; short tokens are word-bounded). These drop automatically. Wellfound
  slugs are screened too.
- **Stack check in the JD (draft time):** main technologies the JD names (languages and
  frameworks from `STACK_VOCAB` in `src/platforms/knowledge.ts`, with aliases such as
  Node / Node.js / NodeJS; not tools like Docker or Jira) are compared with
  `profile.skills`. A job naming one the user lacks goes to `ask_user` with what it wants
  and what the user has; the user keeps or drops it in one batch.
- **Positives:** `desired_roles` and `include_keywords`, weighted into `match_score`.
- **Pay:** `min_salary` against every format seen (Lacs PA, LPA, ₹xL-₹yL, `/month`,
  ranges). Missing pay is unknown, not a reject.
- **Years:** `max_years_required` against the first years match in the JD, including
  label-first forms and decimals, taking the lower bound and ignoring recruiter-bio
  numbers. A specific waiver ("what you've built matters more than years") flags the job
  for the user instead of rejecting it; generic "apply anyway" EEO text does not count.
- **Companies:** `excluded_companies` plus the platform's spam and always-external lists.
- **Recency:** `max_posting_age_hours` (LinkedIn default 24).

## 9. Data model

### Job identity and dedup

Every job Aupply touches is one row in `applications`, keyed by
`unique (user_id, platform, external_id)`. That constraint is also the index behind
"has this user already applied to this job", so a draft's check is one lookup for the
whole batch (`check_applied`, which calls `check_existing_applications`). The table and
index exist already; what the design adds is that the id is always the same for the
same job.

`external_id` is the platform's canonical job id, never a URL or slug:

| Platform | Canonical id | Parsed from |
|---|---|---|
| LinkedIn | numeric job id, `4471873921` | a bare id, `urn:li:jobPosting:<id>`, `/jobs/view/<id>`, `currentJobId=<id>` |
| Naukri | 12-digit job id, `280926903708` | a bare id, the trailing number of a `job-listings-...` URL |
| Wellfound | numeric job id, `3828017` | `/jobs/<id>-<slug>`; the slugged URL goes in `job_url`, because opening a bare id 404s |
| Indeed | 16-character hex `jk`, lowercase | `jk=<jk>`. Connector ids (`JOBSEARCH_nn`) and `to.indeed.com` links change per call and are refused |
| anything else | the ATS job id if there is one, else the URL without query string, fragment or trailing slash | |

- **One function** (`src/platforms/ids.ts`) canonicalises every id on every write and
  every lookup: `log_application`, `check_applied`, `queue_jobs`, `report_results`,
  `record_outcome`.
- **A CHECK constraint** makes the four platforms require an id in canonical form, so a
  URL or an empty id can never be stored for them. An empty id would slip past the
  unique constraint, because Postgres treats NULLs as distinct.
- **What is stored:** every job that cost something to judge or act on: queued
  (`discovered`), applied, unconfirmed, parked, closed, failed, and skipped after a JD
  prescreen or the user's decision. Title-filter rejects are not stored; re-running a
  regex on a card costs nothing, and storing them would add around a hundred rows per
  draft.
- **Applications made outside Aupply** (the user's own sessions) are learned when the
  engine lands on a job and reports `ALREADY_APPLIED`; `report_results` stores it as
  applied, so it never costs a second visit. To verify in the LinkedIn live test: whether
  the tracker page's applied list exposes job ids, in which case the draft can read it
  at the start and catch these before the prescreen.

### Everything else

One new table, `platform_state` (see Build status); everything else fits the existing
schema.

- The queue is `applications` with status `discovered`; rejects are `skipped` with a
  reason code in `status_reason` (and `metadata.skip_code`); Indeed parks are `parked`;
  external jobs are `lead`.
- `applications.metadata`: attempts, attempt ids, engine version, last trace,
  `stack_missing` and `needs_decision` for jobs waiting on the user.
- `platform_state`: backoffs (`blocked_until`), the LinkedIn tracker count, the Naukri chip state, the Wellfound NO_MODAL streak.
- `preferences.rules`: `tech_questions`, `linkedin.daily_cap`, `linkedin.draft_target`,
  `naukri.refresh_skill`, `skip_mid_senior_without_years`.
- Canonical answer keys are defined in code; `answers.key` is already unique per user.

Promote any of these to columns once they are queried, per the metadata convention in
`CLAUDE.md`.

## 10. Code layout

```
src/engines/src/modules/       one factory per file, loaded in this order:
  core.js pay.js               helpers, result store, status/wait; money parsers
  res_base.js res_rules_a.js   the answer registry: facts and parsers, ordered rules,
  res_rules_b.js res_api.js    A() and the option pickers
  linkedin draft engine: li_base li_sweep li_screen li_dmain (with core, pay)
  linkedin apply engine: li_base li_dom li_fill li_job li_main (with core, pay, res_*)
  nk_chat nk_main, wf_apply wf_main, in_fill in_main (each with core, pay, res_*)
src/engines/generated.ts       built by scripts/build-engines.mjs: checksummed parts, boot parts, versions
src/engines/index.ts           config parts, the page-state check and planLoad (what to send next)
src/platforms/
  ids.ts                       canonical job ids, job URLs
  knowledge.ts                 spam and external lists, aggregators, slugs, stack vocabulary
  config.ts                    per-user answer pack and screening rules
  results.ts                   engine result -> status + next
  envelope.ts, jobs.ts         tool response shape, apply lists, blocked response
src/services/automation.ts     queue, results, backoffs, LinkedIn cap
src/services/engines.ts        engine delivery: issue, load_engine, the delivery meter
src/mcp/tools/                 one file per tool, as today (load_engine is how code reaches Claude)
```

`npm run build:engines` runs before `tsc` and fails on an engine that does not parse. The engines themselves are tested live in the browser by the user, not with unit tests (their instruction, 30 Sep); `scripts/e2e.mjs` covers the server side of the tools.

## 11. Not in scope

- **Applying on external ATS sites.** Retired in applix; they arrive as leads. When the
  user asks for a specific one, Claude can fill it by hand with `resolve_answers` and
  record it with `log_application`.
- **Mail.** Out of scope (1 Oct decision): Aupply does not read mail and `start_session`
  hands out no mail searches. `record_outcome` stays for outcomes the user tells Claude.
- **Cold outreach.** Not in the scripts. The evidence in the amendments says guessed
  `hello@` addresses mostly bounce and only named people ever replied; it needs its own
  design (named contacts only, a sent-to list, bounce reconciliation).
- Resume editing, and Naukri profile fields beyond the refresh chip.
- Any server-side scraping (D1).

## 12. Risks

- **LinkedIn's User Agreement forbids automated applying**, so users risk account
  restrictions. Pacing (about 2 minutes per job, 35 a day) keeps volume at human scale. How
  the product words this is a product decision.
- **Claude's browser safety checks can refuse a submission** (seen 28 Sep on a
  Greenhouse-backed posting). The run stops and reports. Never route around a refusal;
  dropping external-ATS postings at draft time avoids the known case.
- **Selectors move.** Engines are versioned on the server, so a fix reaches every user on
  their next call, and results carry the engine version so breakage shows in the data.
- **Claude re-types the engine when loading it, and that is the fixed cost of a session**:
  for a typical user the LinkedIn draft is about 20KB in 7 parts over 2 answers and the
  apply about 60KB in 12 parts over 6 answers (config included; a page that already holds
  modules is sent only the rest), roughly 27K tokens of code to read and to type for both.
  A page that keeps the engine (the tab stays open between chats, same config) is sent
  nothing. Parts are readable and each checks itself, so a mistyped part refuses to load;
  a part with a syntax error never runs, so the load rule tells Claude to copy it again
  and to stop after 3 failures.
- **The engine passes through the user's Claude and browser when it is used.** Delivery
  in pieces, metering and the instruction not to show the code limit exposure; they
  cannot hide code that has to run in the user's browser. The engine source is also in
  the public repo until the MCP launches (see Open decisions in `CLAUDE.md`).

## 13. Build order and sources

1. Answer registry, screening (including the stack check) and fixture tests;
   `resolve_answers`.
2. `queue_jobs`, `report_results`, `start_session`, `end_session`; new server instructions.
3. LinkedIn: `linkedin_draft`, `linkedin_apply`. Live test in the user's browser.
4. Naukri (engine, apply, refresh). 5. Wellfound. 6. Indeed.

Where each port starts:
- **LinkedIn:** `05-SCRIPTS-linkedin-engine.js` in Drive (30 Sep, live-tested: 22 of 22
  on 28 Sep, one more on 30 Sep). Replace the hardcoded values with generated config,
  replace the `__A0 → __Av1 → __Av2 → __Av3 → __A1x → __A` chain with the registry,
  split `__sweep` + `__filt` from `__pre2` so `check_applied` runs between them, and
  restore `ALREADY_APPLIED`, which the 30 Sep `__job` folds into `NO_EASY_APPLY` although
  it must be stored as applied.
- **Naukri and Wellfound drafts:** `04a-sweeps.js` sections 3 and 4 in Drive (current).
- **Naukri and Wellfound apply engines:** the 16 Sep Mac copies plus the patches the
  amendments describe (44, 62, 75, 77). The newest code (the 28 Sep Wellfound engine and
  the 25 and 28 Sep Naukri `answer()` patches) is only in the Claude project "apply".
- **Indeed:** `claude/SCRIPTS-indeed-v2.md`, also only in the Claude project; the Mac copy
  plus amendments 21 to 25 otherwise.

## 14. Server instructions (draft)

```
Aupply holds the user's job-search data and the scripts that apply to jobs on LinkedIn,
Naukri, Wellfound and Indeed. The scripts run in the user's own browser through your
browser tool; Aupply never contacts job sites itself.

Aupply applies to jobs only through its own tools and engines. Do not browse a job board's
list and click through jobs or forms yourself, unless the user names one specific job and
asks you to do it by hand. If a tool or the engine is missing, blocked or failing, stop and
tell the user. If a tool named below is not in your tool list, this chat holds an
out-of-date copy of the tools: ask the user to reconnect the connector and start a new
chat. Do not take screenshots to check the engine's work; its answers are the record.

1. Call start_session. Raise anything in pending_actions before applying to anything new.
2. For each platform: <platform>_draft, then follow its steps (on LinkedIn: sweep,
   check_applied, prescreen), then queue_jobs. The engine reaches the page only through
   load_engine, a few parts at a time: run the loaded_check block the tool gave you;
   unless it answers ok, call load_engine with the tool's engine and the page's answer,
   run each code block it returns as its own JavaScript call, exactly as written, and call
   it again with the last block's answer until it says ready. If a block fails
   (SyntaxError or "corrupt"), copy that block again exactly; after 3 failures stop and
   report the exact error. Never ask the user to paste code, apply by hand, or show or
   explain the engine code. If queue_jobs returns ask_user, show the user those jobs in
   one message and pass their answers back as decisions; you can start applying the rest
   meanwhile.
3. <platform>_apply with from_queue, run it, and call report_results after every poll.
   Follow each response's `next`.
4. When a question is unanswerable, call resolve_answers; if it is still unknown, ask the
   user. Never invent a protected fact; skip the job instead.
5. The engine's verdict is not proof. Report the platform's own applied count when a
   response asks for it.
6. Call end_session, then tell the user: counts per platform (from end_session), what
   broke, an honest read of the funnel, and any provisional answers used.

If you cannot control a browser, say so. You can still screen links the user pastes and
prepare answers.
```

## 15. Decisions log

Settled 30 Sep 2026:
- Priorities: never hit a rate limit (hard constraint), then automation, then accuracy,
  then fewest tokens and most determinism. Time does not matter. The dashboard is a
  nice-to-have; the MCP tools are the product.
- Drafting means building the apply queue (LinkedIn: 30 to 40 jobs a day). There is no
  fill-without-submit mode; the apply tools submit. Indeed always parks at the CAPTCHA.
- Technology questions: Yes inside every application. While drafting, jobs whose JD
  names a main technology the user doesn't list are asked about in one batch.
- Execution: Claude's browser tool only. No Aupply extension.
- Every job is stored under `(user_id, platform, canonical job id)`, and drafts check
  that index before the JD prescreen. LinkedIn drafts are Easy Apply only.
- The engine is the product and is guarded: the server chooses which parts Claude gets,
  and only when Claude asks (`load_engine`); no response carries a whole engine, and a
  platform tool carries no engine code at all. The engine is never published: no public
  or ticket-based script URLs, nothing served to a page, only MCP calls.

Still open:
- India only for v1 (location ids, Naukri)? Assumed yes.
- Engine exposure through the repo: `src/engines/src/modules` and `generated.ts` are in
  the public repo 57suraj/aupply. Decided 1 Oct: it stays public until the MCP is made
  public, then goes private. Delivery guards mean little until then.
