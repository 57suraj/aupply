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
| 3. AI module | not started |
| 4. Draft pipeline | not started |
| 5. Apply pipeline | not started |
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

## Open issues

None so far.
