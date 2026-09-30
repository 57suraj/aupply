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
answers, never inventing personal facts, outcomes that wait on a human.

**Status:** backend works end to end (OAuth connector, 13 MCP tools, dashboard
API). The dashboard UI sections are still placeholders ("coming in next phase");
leave them until asked. **Payments are on hold**: the provider is undecided, so do
not build on Stripe or `subscriptions`, and do not gate tools on a subscription.

## Layout

- `client/src`: React 19 + Vite + Tailwind SPA. Supabase Auth in the browser (anon key).
- `src/app.ts`: Express 5 app, routes only. Imported by `api/index.ts` (Vercel
  function) and `src/server.ts` (local dev / self-host: static SPA + listen).
- `src/auth`: OAuth 2.1 server (`oauthProvider.ts` plugged into the MCP SDK's
  `mcpAuthRouter`), consent API, Supabase-session middleware for `/api`.
- `src/services`: all data access, shared by MCP tools and REST routes.
- `src/domain/schemas.ts`: zod inputs and enums; enums mirror the DB CHECK constraints.
- `src/mcp/tools`: one file per tool; `src/mcp/toolkit.ts` wraps auth, errors, compact JSON.
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
  is the "waiting on the human" queue. `(source, external_ref)` dedups imports such as Gmail ids.
- `answers`: reusable answer library. `key` names canonical facts (`notice_period`,
  `sponsorship.us`); null for ad-hoc answers. Claude's saves are `provisional` unless
  the user stated them, and a confirmed answer is never overwritten by a provisional one.
- `application_questions`: per-application Q&A log, trigram-searched with saved answers.
- `oauth_clients` / `oauth_grants` / `oauth_authorization_codes`: connector auth.
  A grant is a "connection" (listed and revoked at `/api/connections`).
- Resume files live in private bucket `resumes` at `<user_id>/<resume_id>/<file_name>`;
  the browser uploads via a signed URL, then `POST /api/resumes/:id/file` extracts text
  (PDF, txt, md; DOCX is stored but not parsed).

## Open decisions

- Payment provider (Stripe code exists but is on hold). Known Stripe bug for whoever
  resumes it: the webhook derives `current_period_end` from `billing_cycle_anchor + 30d`,
  which is in the past after month one; use the subscription item's `current_period_end`.
- Dashboard UI for the new API (profile, resumes, answers, applications, connections).
- Custom SMTP, then re-enable email confirmation.
- The frontend uses the legacy anon JWT key; can move to the `sb_publishable_` key.
- Later: pgvector for semantic answer matching, `org_id` if teams ever arrive.
