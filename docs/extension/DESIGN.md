# Aupply Chrome extension (LinkedIn): design as built

Living document. `BUILD-INSTRUCTIONS.md` is the plan; this file records what was actually
built, every deviation from the plan and why, and open issues. Updated at the end of each
build phase.

The extension is a second channel next to the MCP server, decided with the user on 4 Oct
2026. Decision D1 in `docs/automation-tools.md` ("there is no Aupply browser extension")
still describes the MCP channel and stays true for it.

## Build status

| Phase | State |
|---|---|
| 0. Orientation | done: MCP e2e baseline 153 passed |
| 1. Database | done |
| 2. `/ext` function, auth, devices | done: e2e-ext sections 1 to 4 |
| 3. AI module | done in fake mode; smoke test waits on `DEEPSEEK_API_KEY` |
| 4. Draft pipeline | done: e2e-ext sections 5 and 6 |
| 5. Apply pipeline | done: e2e-ext sections 7 to 11 |
| 6. The extension | not started |
| 7. Website pages | not started |
| 8. Hardening | not started |
| 9. Documentation | not started |

## Database

Migration `supabase/migrations/20261003191945_extension_channel.sql`, applied exactly as
section 6.3 of the plan: nine tables (`ext_devices`, `ext_pairings`, `ext_drafts`,
`ext_leases`, `ext_questions`, `ext_resume_profiles`, `ext_ai_usage`, `ext_events`,
`job_postings`) and two service-role functions (`ext_issue_lease`, `ext_add_ai_usage`).
No existing table, column, constraint, function or policy changed.

Advisors after applying: security shows only the two intended INFO notices (RLS on, no
policy) for `ext_pairings` and `job_postings`, which are service-role only like
`oauth_clients`. Performance shows only "unused index" INFO notices for the new indexes,
which have had no traffic yet.

`src/db/database.types.ts` gained the new tables and functions where the generator places
them; nothing else in it changed.

## The /ext function (phase 2)

`api/ext.ts` exports `src/extension/server/app.ts`, an Express 5 app under `/ext/v1`, routed by
one rewrite in `vercel.json` (before the SPA fallback), with `maxDuration` 60 and the daily
cleanup cron (21:30 UTC, 03:00 IST). Locally `npm run dev:ext` listens on 3001 and Vite proxies
`/ext` to it.

- Errors: `{ error: { code, message, ...extra } }` (`server/http.ts`). `AppError`s from imported
  MCP services map by status; 5xx never carries internals.
- Version gate: every device endpoint needs `X-Aupply-Ext-Version` at or above
  `EXT_MIN_VERSION`, else 426 with `min_version` and `download_url` (the zip's absolute URL).
- Device auth (`auth/`): pairing, poll, refresh and revoke as section 7.3. Access tokens are
  HS256 with `EXT_JWT_SECRET`, `iss = ISSUER`, `aud = ${BASE_URL}/ext`, `did` claim.
- Housekeeping: `services/cleanup.ts` (cron and lazily per user), `services/events.ts`
  (`ext_events`, 2KB per event), `services/leases.ts` (issue, complete, expire).

Vercel environment (set 4 Oct with the Vercel MCP): `EXT_JWT_SECRET` and `CRON_SECRET`
(sensitive, generated, Production and Preview only: Vercel does not allow sensitive variables in
Development, the same as the existing `JWT_SECRET`), `AI_BASE_URL`, `AI_FAST_MODEL`,
`AI_SMART_MODEL`, `EXT_AI_DAILY_BUDGET_MICRO_USD`, `EXT_MIN_VERSION=0.1.0`,
`EXT_LINKEDIN_ENABLED=true` (plain, all three). `DEEPSEEK_API_KEY` is the user's to add.

Testing: `npm run e2e:ext` against a local server started as
`MCP_BASE_URL=http://localhost:3101 EXT_PORT=3101 AI_FAKE=1 EXT_MIN_VERSION=0.1.0 CRON_SECRET=e2e-cron-secret npx tsx src/extension/server/dev.ts`
(the plan's command plus a minimum version, so the gate is tested, and a known cron secret).

## AI module (phase 3)

`src/extension/ai/`: `client.ts` (`callJson`, two tiers, budget, retries, usage), `pricing.ts`,
`usage.ts`, `fake.ts` (`AI_FAKE=1`), and `prompts/` with Appendix B's five prompts verbatim, each
with a `PROMPT_VERSION` and a zod schema that clamps and cuts (a verdict is always recomputed
from the clamped score). `prompts/common.ts` holds the contact redaction, `stableJson` (sorted
keys, for the prefix cache) and `extractJson` (the first JSON object in the content).

- OpenAI SDK 7.27 (`openai`), base URL `AI_BASE_URL`, `maxRetries: 0` (the client retries
  itself: one retry for empty or invalid output, two for 429, 5xx and network errors at 2s and
  6s). `thinking` is added to the params with a narrow cast.
- Budget: the user's spend for the UTC day from `ext_ai_usage` is checked before every call;
  at or over `EXT_AI_DAILY_BUDGET_MICRO_USD` the call throws `AiBudgetExceeded`. Fake calls
  record usage at zero cost under model `fake`.
- Prices re-checked on 4 Oct against api-docs.deepseek.com: the same numbers as the plan
  (Flash $0.006 hit, $0.30 miss, $1.20 out per 1M tokens at peak; Pro $0.044 / $1.32 / $3.96).
  That page does not mention the Pro-to-Flash routing.
- `engine/modules.ts` loads `core`, the resolver modules, `li_screen` and `li_dom` from
  `src/engines/generated.ts` through `node:vm` and exposes `clean`, `yearsOf`, `NEVERTICK`,
  `CONSENT`, a per-user resolver and `payMax`. The self-check runs once per process and
  `/health` reports it (`engine.ok`).
- `services/resumeProfile.ts`: the profile per resume version (`pickResume`, sha256 of the
  text), cached in `ext_resume_profiles`; no resume text or no AI gives a profile from the
  profile fields (`basis: 'profile'`, not cached). Also the fit prompt's candidate block.
- `POST /onboarding/propose`: email and phone by regex (never sent to the AI); the rest of the
  resume (emails and phones removed, the city kept) to the smart tier; each proposed field kept
  only if the MCP's own schema accepts it. No AI (no key, budget spent, errors): the proposal
  carries the regex fields and `ai_used: false`, never an error.
- `npm run ai:smoke` (`scripts/ai-smoke.mjs`, run through tsx so it uses the client's own
  `buildParams`): not run yet, `DEEPSEEK_API_KEY` is not set. Findings go here when it runs.
  `AI_SMART_JSON_MODE=off` switches the smart tier to prompt-only JSON if JSON mode fails with
  thinking on.

## Sessions and the draft (phase 4)

- `services/sessions.ts`: `session/start` (section 7.6's checks in order), `heartbeat`, `end`
  (counts, saved jobs, provisional answers used, the tracker check). Starting a run ends this
  device's older open runs and other devices' runs that stopped beating, so none can resume
  next to the new one. `services/entitlement.ts`: `isSubscribed` is always true (payments on
  hold).
- "Claude is active" (`claudeActivity`): `platform_state` `engine_linkedin` or
  `engine_linkedin_draft` written in the last 30 minutes (the MCP writes them on every engine
  issue and delivery; a trigger keeps `updated_at`), or a LinkedIn application changed in the
  last 15 minutes by something other than the extension. `retry_at` is when the newest activity
  ages out of its window.
- `POST /linkedin/tracker` (section 9.8) is built here, because every run starts with a tracker
  lease. It stores the count exactly as the MCP's `noteTracker` does and keeps the run's first
  and last reading.
- `services/draft.ts`: the draft state machine in `ext_drafts.state` (screening config, search
  progress, candidates, JD queue, jobs to score, rate-limit hits). Every order is a lease, paced
  2 seconds after the last draft lease finished. `services/scoring.ts`: JD facts (shared in
  `job_postings`), the resume profile, the fit score, the deterministic fallback and the queue
  row. `services/postings.ts`: the shared cache. `linkedin/guest.ts`, `titleFilter.ts`,
  `prescreen.ts`: the ports, each citing its source.
- Decisions (`services/questions.ts`) and the queue view and skip (`services/queue.ts`) as
  sections 8.6 and 8.7; item ids are the application row's uuid, with `job_id` alongside.

## The apply pipeline (phase 5)

- `apply/next` (`services/apply.ts`), in order: the device's own open apply or tracker lease
  (a restarted service worker gets the same work back), expired leases settled, a `linkedin`
  backoff (wait when it ends within 2 hours, else done), Claude at work, the shared cap, a
  tracker read when due, then the best ready job (or an UNCONFIRMED job of this run to verify),
  paced 30 to 45 seconds after the user's last apply lease finished.
- Tracker reads: at the start of every run, after every 10 apply leases in the run, and once
  more before the run reports `done` when jobs were sent since the last read, so the end-of-run
  check (tracker moved at least as much as SENT + UNCONFIRMED) judges a fresh count.
- `apply/answers` (`services/formAnswers.ts` + `linkedin/fields.ts`): the deterministic rules,
  then saved and past answers, then AI where section 10.6 allows it, then `ext_questions`. Every
  answer is recorded on the lease per page; the result logs them to `application_questions`
  (one entry per question; the unlabeled date selects are named "Education start month" and so
  on).
- `apply/result`: `mapResult` with the extension's rules on top (saved on a strong match,
  NEEDS_INPUT, the two rate-limit steps, the daily limit, CHECKPOINT and LOGGED_OUT stop,
  USER_NAVIGATED pauses, retries go 15 minutes to the back of the queue). The outcome is stored
  on the lease, so a repeated result gets the same answer and nothing is recorded twice. An
  expired apply lease is settled as `ERR` (`e: lease_expired`).
- Questions (`services/questions.ts`): answering saves the user's confirmed answer
  (`source = 'user'`, with the protected key when there is one) and releases every waiting job
  at once; dismissing skips them. Review lists the extension AI's provisional answers.

## Deviations from the plan

- Files beyond section 5's layout: `services/me.ts` (`GET /me`), `services/queue.ts` (the ready
  queue shared by `/me`, `apply/next` and the queue view), `services/cleanup.ts` (cron and lazy
  cleanup).
- `/me`'s `live_run` also says `this_device`, so the side panel can tell its own run from
  another device's.
- An approved pairing can still be collected for 10 minutes after its code expires (the user
  may approve in the last seconds). A poll with an unknown pairing id or a wrong secret is 404.
- The website endpoints use the imported `requireUser`, whose 401 body is the MCP's
  `{ error: "..." }` string, not the contract's object. The website's helper handles both.
- Ending a stale run (cleanup) also closes its open leases as `ABORTED`.
- `/onboarding/propose` answers with `ai_used`; without AI it still answers (regex fields only)
  instead of a 503, so the side panel's form is always filled as far as it can be.
- New env `AI_SMART_JSON_MODE` (see the AI section). `/health` also reports the engine
  self-check.

- Search orders hold the next page of each active search (up to 5), not consecutive pages of
  one search, so the "fewer than 10 cards ends that search's paging" rule applies between
  orders and no page is fetched after a short one. "First window wins" is kept as "the freshest
  window a job was found in wins", which is the same result in any fetch order.
- A search rate limit (429 or 999) blocks `linkedin_guest` for 60 minutes and finishes the draft
  with no JD reads at all (the guest API is in a backoff); jobs found in the shared cache are
  still screened and scored. Unread jobs are not stored, so the next draft finds them again.
- Scoring runs inside `draft/next`, at most 25 seconds per request (4 at a time). When jobs are
  left to score but nothing is left to read, the answer is `{ type: "wait", reason: "working",
  until: now }`: the extension asks again at once. Wait reasons also include `blocked`.
- `draft/next` takes `lease_id` and `result` as optional (a call after a wait has neither); a
  repeated result for a completed lease is answered with the next order, never processed twice.
  `ext_drafts` saves are optimistic on `updated_at`, so two calls at once cannot clobber the
  state (the second gets 409 and asks again).
- `DraftOrder` and `draft/start` also answer `{ type: "disabled" }` (kill switch).
- The "Claude is active" check does not count the extension's own rows (`metadata.channel`
  'extension' or `engine` 'ext@...') or manual applies (`applied_by` 'user'). The plan's literal
  rule ("engine not starting with ext@") would have treated every row a draft writes, which has
  no `engine`, as Claude's.
- A draft also ends (stop `target`) when the target is reached, and (stop `blocked`) when a
  backoff would last more than 2 hours.
- Extra file: `services/scoring.ts`.

- A second `apply/next` from the same device while its apply lease is open returns that same
  lease (so a restarted service worker resumes) instead of `wait lease_busy`. Other work while a
  lease is open (a draft, another device) still gets `lease_busy`; e2e checks that only one lease
  is ever open.
- `apply/next` settles expired leases before it picks a job (the first build settled them inside
  `issueLease`, after the pick, so the expired job was handed straight back; e2e caught it).
- One more tracker read before `done` (see the apply section).
- AI is not asked on a page that has a protected fact (the job is skipped anyway), nor for
  typeaheads, lone checkboxes or date selects. A page's AI questions run in parallel with a 40
  second deadline. The saved answers the AI sees leave out protected keys, money (`comp.*`) and
  any question about salary, phone, email, address, date of birth or ids.
- `NEEDS_CLICK` and `FOLLOW_STUCK` are retried once (then failed), as section 11.6 describes;
  `mapResult` alone would leave them as handoffs. A `NEEDS_INPUT` job whose question the user
  dismissed is skipped; one whose questions were all answered meanwhile is retried later.
- A question answered once but asked again (the saved answer did not settle it) is reopened.

## Open issues

None so far.
