# Aupply

## What this is

A $2/month SaaS that lets Claude apply to jobs for a user. Users sign up on the
web app, store their candidate data (profile, resumes, preferences, reusable
screening answers) and add Aupply to Claude as a **remote MCP connector**.
Claude reads that data through MCP tools and writes back every application,
skip and outcome.

It productises the personal automation in `/Users/suraj/applix` (LinkedIn Easy
Apply, Wellfound, Naukri, Indeed). Its README and RUNBOOK hold the lessons the
data model is built on: dedup by (platform, job id), provisional vs confirmed
answers, never inventing personal facts, outcomes that wait on a human. The newer
applix knowledge (amendments up to #84, 28 Sep) is in Google Drive folder
`1ISY883-VdE9OS52xPU2-wDLfbfbWOrJ0`; list it and read by title, since file ids change.

**Status:** backend works end to end (OAuth connector, 27 MCP tools, dashboard
API): 13 data tools (including `resolve_answers` and `update_profile`, which onboards a
user from their resume), `start_session` / `end_session`, and 12
automation tools (draft and apply on LinkedIn, Naukri, Wellfound, Indeed, plus
`queue_jobs`, `report_results` and `load_engine`). The automation tools are **built but not yet
proven in a browser** (the live tests stopped at loading the engine; it now reaches the
page in small parts the server hands out on request): see `docs/automation-tools.md`. **The MCP tools are the product; the dashboard is a
nice-to-have**, so automation work comes before dashboard work. Dashboard UI: the Resume section is real (`client/src/components/ResumeManager.tsx`);
the other sections are still placeholders ("coming in next phase"), leave them until asked. **Payments are on hold**: the provider is undecided, so do
not build on Stripe or `subscriptions`, and do not gate tools on a subscription.

## Layout

- `client/src`: React 19 + Vite + Tailwind SPA. Supabase Auth in the browser (anon key).
- `src/app.ts`: Express 5 app, routes only. Imported by `api/index.ts` (Vercel
  function) and `src/server.ts` (local dev / self-host: static SPA + listen).
- `src/auth`: OAuth 2.1 server (`oauthProvider.ts` plugged into the MCP SDK's
  `mcpAuthRouter`), consent API, Supabase-session middleware for `/api`.
- `src/services`: all data access, shared by MCP tools and REST routes.
  `src/services/engines.ts`: engine delivery (issue, `load_engine`, the delivery meter).
- `src/domain/schemas.ts`: zod inputs and enums; enums mirror the DB CHECK constraints.
- `src/mcp/tools`: one file per tool; `src/mcp/toolkit.ts` wraps auth, errors, compact JSON
  (it drops null/empty values, so an empty array comes back missing). Code in a result
  goes out as `Reply` text blocks after the JSON, never inside it (see below).
- `src/engines/src/modules`: the browser engines as modules, one factory per file
  (shared `core`, `pay` and `res_*`, then `li_*` (LinkedIn has a draft and an apply
  engine), `nk_*`, `wf_*`, `in_*`). `scripts/build-engines.mjs` turns each into a small
  checksummed part, checks them (parse, size, undeclared names, every engine boots in a
  stub page) and writes `src/engines/generated.ts`, which is committed. After editing a
  module run `npm run build:engines` and commit the generated file.
  `src/engines/index.ts`: config parts, the page-state check and `planLoad` (what to
  send next).
- `src/platforms`: job ids, platform knowledge, per-user engine config, result mapping.
  `src/services/automation.ts`: queue, results, backoffs, LinkedIn cap.
- `src/api`: dashboard REST routes (thin: parse with zod, call a service).
- `supabase/migrations`: schema source of truth; `src/db/database.types.ts` is generated.
- `scripts/e2e.mjs`: end-to-end suite (`npm run e2e`). Run it after backend changes.

## Accounts (be careful)

- **GitHub: `57suraj/aupply` only** (personal, public). This Mac's SSH key and
  keychain token belong to the company account `suraj-ambati`. Keep the remote
  on HTTPS. The repo-local credential helper is `gh auth git-credential`; confirm
  `gh api user --jq .login` prints `57suraj` before pushing. (`gh` itself is logged
  in globally as 57suraj; git elsewhere still uses the company credentials.)
- **Supabase**: project `aupply`, ref `lzkvozibmodysycztatl`, **ap-south-1 (Mumbai)**,
  org "Aupply". Auth **"Confirm email" is OFF** on purpose: the built-in mailer allows
  about 2 emails/hour. Turn it back on only after configuring custom SMTP.
- **Vercel**: account `aupply1k@gmail.com` (Hobby), project `aupply`
  (`prj_nxOSlepuWXZOkzYhn4KfnuZVqLWW`), Git-linked, so every push to `main` deploys
  to production. Public URL **https://aupply.vercel.app**; the other `*.vercel.app`
  aliases sit behind Vercel Authentication. Functions pinned to `bom1` next to the DB.
  The Vercel MCP connector returns 403 when given the team id; call it without `teamId`.

## Deployment (Vercel)

- `vercel.json`: Vite builds the SPA to `client/dist`; one function (`api/index.ts`)
  wraps Express. Rewrites send `/mcp`, `/health`, `/authorize`, `/token`, `/register`,
  `/revoke`, `/.well-known/*` and `/api/*` to it; everything else falls back to
  `index.html`. **A new top-level backend path must be added to the rewrites and to
  the dev proxy in `vite.config.ts`.** `/oauth/consent` is a SPA page.
- `NODEJS_HELPERS=0` so Express parses bodies itself (the Stripe webhook needs the raw body).
- `VITE_*` values are baked in at build time; changing one needs a redeploy.
- Express 5: wildcards need a name (`/{*splat}`); a bare `*` throws at startup.

## OAuth / MCP auth

- Claude connects with the MCP spec flow: 401 + `WWW-Authenticate resource_metadata`
  on `/mcp`, discovery via `/.well-known/*`, dynamic client registration, PKCE (S256),
  refresh tokens. The SDK handlers do the protocol and PKCE check; `oauthProvider.ts`
  does storage and policy. Don't hand-roll protocol endpoints.
- `/authorize` redirects to the SPA consent page with a signed `request` token; the
  consent API trusts only that token plus the Supabase session, never URL params.
- Access tokens: 1h HS256 JWTs (`JWT_SECRET`), aud = `${BASE}/mcp`, carry a grant id.
  Every MCP call checks the grant isn't revoked, so revoking in the dashboard is immediate.
  Refresh tokens rotate on each use (90d sliding). A replayed auth code revokes its grant.
- `ISSUER` = `new URL(BASE_URL).href` (trailing slash). Use it anywhere an issuer is
  emitted (`iss`, metadata), or clients that validate RFC 9207 `iss` will fail.
- Client secrets never expire (the SDK default of 30 days would break Claude after a month)
  and are stored as issued, because the SDK compares them verbatim.
- Tools get the user id only from `extra.authInfo` (via `toolkit.run`). Never from input.
- `/api/*` authenticates with the Supabase session JWT via `getClaims()` (verified
  locally with the project's ES256 keys). MCP tokens are not valid there, and vice versa.

## Database rules

Schema change workflow: new migration file (never edit an applied one), then apply with
Supabase MCP `apply_migration`, rename the local file to the version `list_migrations`
reports, regenerate the types, run `get_advisors`, then `npm run e2e`.

Conventions for every table:
- `user_id` references `auth.users` on delete cascade. RLS on, with
  `(select auth.uid()) = user_id` policies for `authenticated`.
- Child tables reference parents with a composite FK `(parent_id, user_id)`, so a
  row can never point at another user's data. Parents expose `unique (id, user_id)`.
- Enum-like columns are `text` + CHECK. Extend by replacing the constraint in a
  migration and updating `src/domain/schemas.ts`. Exception: `subscriptions.status`
  mirrors Stripe and stays unconstrained.
- New or experimental fields go in `metadata jsonb` first; promote to a column once queried.
- Money is `bigint` whole units + ISO currency + period (`year|month|hour`).
- Use real unique constraints where `ON CONFLICT` is needed, never partial indexes
  (an applix lesson).
- The backend uses the service role, which bypasses RLS, so **every server query must
  filter by the authenticated user id**.
- **Triggers that write to another table must be `security definer`.** Supabase Auth
  deletes users as `supabase_auth_admin`; cascades fire triggers under that role, and an
  invoker trigger fails with "permission denied", which blocks account deletion.
- SQL helpers that take a user id (`find_similar_answers`, `check_existing_applications`,
  `application_stats`, `mark_answers_used`) are revoked from anon/authenticated;
  only the service role calls them.

Domain semantics:
- `applications`: one row per job touched. Dedup key `(user_id, platform, external_id)`;
  `log_application` upserts on it and only updates the fields passed. `status` is what
  we did (`discovered, lead, skipped, parked, applied, unconfirmed, failed, closed`).
  `stage` is what the employer did: a trigger derives it from `application_events`,
  so never write it directly; insert an event.
- `application_events`: outcomes and notes. `action_required and not action_done`
  is the "waiting on the human" queue. `(source, external_ref)` dedups imports from any source.
- `answers`: reusable answer library. `key` names canonical facts (`notice_period`,
  `sponsorship.us`); null for ad-hoc answers. Claude's saves are `provisional` unless
  the user stated them, and a confirmed answer is never overwritten by a provisional one.
- `application_questions`: per-application Q&A log, trigram-searched with saved answers.
- `oauth_clients` / `oauth_grants` / `oauth_authorization_codes`: connector auth.
  A grant is a "connection" (listed and revoked at `/api/connections`).
- `platform_state`: per user and scope (a platform, or `linkedin_guest` for LinkedIn's
  guest API): rate-limit backoffs (`blocked_until`) and small machine state. Written only
  by the server; the platform tools refuse to issue a script while a backoff is active.
- `applications.external_id` must be the canonical job id for linkedin, naukri,
  wellfound and indeed (DB CHECK `applications_external_id_canonical`); every write goes
  through `canonicalJobId()` in `src/platforms/ids.ts`. The queue is `status =
  'discovered'` with `metadata.needs_decision` false (index `applications_queue`).
- Resume files live in private bucket `resumes` at `<user_id>/<resume_id>/<file_name>`;
  the browser uploads via a signed URL, then `POST /api/resumes/:id/file` extracts text
  (PDF, DOCX, txt, md; legacy .doc is stored but not parsed).

## Automation tools (built, not live-tested)

Full design: `docs/automation-tools.md`. Read it before touching anything under
`src/engines`, `src/platforms`, `src/answers` or `src/screening`. The rules that hold
everywhere:

- **Priorities, in order:** never hit a platform's rate limit (a hard constraint that
  outranks everything, including daily targets and speed); automation; accuracy; fewest
  tokens and most determinism (scripts and server code decide, Claude executes). Time
  does not matter. The rate-limit table is in `docs/automation-tools.md` ("Rate
  limits"); pacing lives inside the engines and backoffs on the server, never in
  Claude's hands.

- Platform scripts run in the user's browser through Claude's browser tool. Aupply's
  servers never contact a job site, and there is no Aupply extension: Aupply only
  hands the user's own Claude the scripts and instructions.
- "Drafting" means building the apply queue (LinkedIn: the day's 30 to 40 best jobs).
  Apply tools submit, taking ids or links or `from_queue`; there is no
  fill-without-submit mode. Indeed always stops at the CAPTCHA for the user.
- Technology questions: while drafting, jobs whose JD names a main technology the user
  doesn't list are asked about in one batch; inside an application every technology
  or stack question is answered Yes.
- One tool per platform per action (`linkedin_draft`, `linkedin_apply`, `naukri_*`,
  `wellfound_*`, `indeed_*`); shared tools for data (`check_applied`, `queue_jobs`,
  `report_results`, `resolve_answers`, `update_profile`, `start_session`, `end_session`).
- Job identity: `applications.external_id` is the platform's canonical job id (LinkedIn
  numeric id, Naukri 12-digit id, Wellfound numeric id, Indeed `jk`), never a URL or
  slug, canonicalised by one function on every write and lookup. Drafts run
  `check_applied` (one lookup on the unique index) before any costly step. LinkedIn
  drafts are Easy Apply only.
- **The engine is the product, so the server decides what Claude gets and when.** A
  platform tool returns steps, an engine id and a tiny `loaded_check` block, never engine
  code. Claude runs `loaded_check` in its page; unless it answers `ok` it calls
  `load_engine` with the page's answer (the page's state), and the server sends only the
  next few parts the page lacks: at most 12KB of module code per answer, never every
  module of an engine in one answer. Never add another way for engine code to reach
  Claude (no "send everything", debug dumps, or code in tool descriptions, instructions
  or docs served to clients). Deliveries are metered per user, engine and day
  (`DAY_LOADS` full engines), logged, and stop during a platform backoff.
- Code travels as verbatim text blocks, each labelled `/*aupply <engine> <part>*/`, never
  inside a JSON string: escaped code has to be unescaped by Claude while copying, and one
  slip is a SyntaxError no checksum can catch. The user's config is a plain object built
  in the page (`window.__apc`), not JSON inside JavaScript. Anything Claude copies that
  has consequences carries a checksum (the LinkedIn queue's job ids). A failed block (a
  SyntaxError or a `corrupt ...` answer) is copied again; after 3 failures Claude stops
  and reports the exact error, never applies by hand or asks the user to paste code.
- A chat keeps the tool list and instructions it read when its connector was added until
  the connector is reconnected (30 Sep: a Claude in Chrome chat still had the first
  deploy's tools, called `log_run`, and clicked through LinkedIn by hand, so none of the
  new flow ran). After changing tools: reconnect the connector and start a new chat before
  a live test. The server answers a call to an unknown tool with a message saying so
  (`staleToolCall` in `src/mcp/server.ts`), and the instructions forbid clicking through
  job boards by hand and screenshot verification.
- A chat drafts only when a platform's queue is low (`QUEUE_ENOUGH` in `src/services/sessions.ts`):
  start_session's `next` sends a healthy queue straight to apply. Drafting means loading the draft
  engine and sweeping the platform, and a fresh LinkedIn page already costs about 78KB of code per
  chat (draft 20KB in 2 answers, apply 58KB in 7); `load_engine` reports `answers_left`.
- Server instructions (`INSTRUCTIONS` in `src/mcp/server.ts`) stay under 2000 characters:
  Claude Code cuts them at 2048 (30 Sep: a 3.6KB text stopped mid-sentence and lost the rate-limit
  rules), so the rules that matter come first and details travel in tool responses. e2e checks it.
  Aupply does nothing with mail: no mail searches, no mail instructions.
- Engine code is emitted readable on purpose (real names, one statement per line): Claude
  copies it by hand and mis-copies dense minified code. A part's checksum ignores line
  edges. `wait` is event-driven (one timer, at most 35s), never a polling loop of sleeps.
  A hidden tab is normal (Chrome behind the Claude app): `sleep` starts each timer from a
  message task so Chrome's heavy throttling never applies, and the LinkedIn runner never
  waits for the tab to be shown (1 Oct: it sat paused until the user brought Chrome
  forward). `hid:1` on a status or a LinkedIn result says the tab was hidden. Phone fields
  get the national number (`me.phoneNational`). No
  `\uXXXX` escapes in engine sources: copiers resolve them and the checksum fails (the
  build rejects one).
- The Chrome extension cuts a JavaScript answer at 1000 characters: no engine answer may
  pass 900 (`ANSWER_MAX` in `core`). Results that do not fit wait for the next
  `status()` (`more:N`), big lists go out in chunks with a `done:1` summary, and the
  build checks it. Never return a big object from the page in one answer.
- The first live LinkedIn run (1 Oct: 4 sent, 2 stalled, 1 protected) found: decimal years
  in LinkedIn's whole-number fields, the job page's Save button clicked (jobs bookmarked),
  and three facts answered Yes by the technology rules (total-years thresholds, "worked
  with <employer>", driver's license). All fixed; see docs/automation-tools.md.
- Parts are at most 9KB and loaded by Claude, never the user. Never `eval` on LinkedIn
  (CSP, even on the tracker page after the first load); on Naukri, Wellfound and Indeed
  the engine caches itself in page storage and `loaded_check` re-loads it with no server
  call.
- One engine per platform (LinkedIn has two, so a draft never receives the apply code and
  the reverse), built and checked in this repo, versioned by hash; each part verifies its
  own checksum, so a part mistyped in transit refuses to load. Personal values reach an
  engine only as generated config, never in its source.
- One answer registry shared by every engine and `resolve_answers`; one screening
  module compiled from preferences, used in the page and on the server.
- The queue is `applications` with status `discovered`. Retry, cap and stop rules live
  in `report_results`, not in prose.

## Open decisions

- Payment provider (Stripe code exists but is on hold). Known Stripe bug for whoever
  resumes it: the webhook derives `current_period_end` from `billing_cycle_anchor + 30d`,
  which is in the past after month one; use the subscription item's `current_period_end`.
- Dashboard UI for the new API (profile, resumes, answers, applications, connections).
  Low priority: nice-to-have, not the selling point.
- Custom SMTP, then re-enable email confirmation.
- The frontend uses the legacy anon JWT key; can move to the `sb_publishable_` key.
- Automation: India only for v1 is assumed, not confirmed (`docs/automation-tools.md`
  section 15).
- Repo visibility (decided 1 Oct): `57suraj/aupply` stays public until the MCP is made
  public, because nobody knows about it yet, and goes private at that launch. It holds the
  engine source and `generated.ts`, and history holds a phone number from a live run
  (commit `ba3949f`), so until then treat everything in it as readable by anyone and keep
  personal data out of code, comments, docs and commits.
- Live test of the automation tools in the user's browser. The Naukri and Wellfound
  engines are ports of the 16 Sep scripts; the newer copies (28 Sep Wellfound, Naukri
  `answer()` patches, Indeed v2) exist only in the Claude project "apply".
- Later: pgvector for semantic answer matching, `org_id` if teams ever arrive.
