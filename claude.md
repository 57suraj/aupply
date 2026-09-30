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

**Status: skeleton.** The MCP tools and dashboard sections are deliberate
placeholders ("Not implemented yet", "coming in next phase"). Leave them until
asked. Their TODO snippets predate the schema: `users` is now `profiles`,
`application_history` is `applications`, `resumes.is_active` is `is_default`.

## Layout

- `client/src`: React 19 + Vite + Tailwind SPA. Supabase Auth in the browser (anon key).
- `src/app.ts`: Express 5 app, routes only. Two entrypoints import it:
  `api/index.ts` (Vercel function) and `src/server.ts` (local dev / self-host: static SPA + listen).
- `src/mcp`: stateless Streamable HTTP MCP server at `POST /mcp`.
- `src/auth/oauth.ts`: our own OAuth server issuing HS256 JWTs (`JWT_SECRET`), `sub` = Supabase user id.
- `supabase/migrations`: the schema's source of truth. `src/db/database.types.ts` is generated from it.

## Accounts (be careful)

- **GitHub: `57suraj/aupply` only** (personal, public). This Mac's SSH key and
  keychain token belong to the company account `suraj-ambati`. Keep the remote
  on HTTPS. The repo-local credential helper is `gh auth git-credential`; confirm
  `gh api user --jq .login` prints `57suraj` before pushing. (`gh` itself is logged
  in globally as 57suraj; git elsewhere still uses the company credentials.)
- **Supabase**: project `aupply`, ref `lzkvozibmodysycztatl`, **ap-south-1 (Mumbai)**,
  org "Aupply". The Tokyo project `hidyqwnskqrekfqddzvp` is an unused leftover.
- **Vercel**: account `aupply1k@gmail.com` (Hobby), project `aupply`
  (`prj_nxOSlepuWXZOkzYhn4KfnuZVqLWW`), Git-linked, so every push to `main` deploys
  to production. Public URL **https://aupply.vercel.app**; the other `*.vercel.app`
  aliases sit behind Vercel Authentication. Functions pinned to `bom1` next to the DB.
  The Vercel MCP connector returns 403 when given the team id; call it without `teamId`.

## Deployment (Vercel)

- `vercel.json`: Vite builds the SPA to `client/dist`; one function (`api/index.ts`)
  wraps Express. Rewrites send `/mcp`, `/health`, `/oauth/{authorize,token,callback}`,
  `/.well-known/*` and `/api/*` to it; everything else falls back to `index.html`.
  **Every new backend path must be added to the rewrites.** `/oauth/consent` is a SPA page.
- `NODEJS_HELPERS=0` so Express parses bodies itself (the Stripe webhook needs the raw body).
- `VITE_*` values are baked in at build time; changing one needs a redeploy.
- Supabase Auth "Site URL" must be the production URL or confirmation emails link to localhost.
- Express 5: wildcards need a name (`/{*splat}`); a bare `*` throws at startup.

## Database rules

Schema change workflow: new migration file (never edit an applied one), then apply with
Supabase MCP `apply_migration`, rename the local file to the version `list_migrations`
reports, regenerate the types, and run `get_advisors` for security and performance.

Conventions for every table:
- `user_id` references `auth.users` on delete cascade. RLS on, with
  `(select auth.uid()) = user_id` policies for `authenticated`.
- Child tables reference parents with a composite FK `(parent_id, user_id)`, so a
  row can never point at another user's data. Parents expose `unique (id, user_id)`.
- Enum-like columns are `text` + CHECK. Extend by replacing the constraint in a
  migration and updating the zod enum. Exception: `subscriptions.status` mirrors
  Stripe and stays unconstrained.
- New or experimental fields go in `metadata jsonb` first; promote to a column once queried.
- Money is `bigint` whole units + ISO currency + period (`year|month|hour`).
- Use real unique constraints where `ON CONFLICT` is needed, never partial indexes
  (an applix lesson).
- The backend uses the service role, which bypasses RLS, so **every server query must
  filter by the authenticated user id**. Never accept a user id from MCP tool input.

Domain semantics:
- `applications`: one row per job touched. Dedup key `(user_id, platform, external_id)`.
  `status` is what we did (`discovered, lead, skipped, parked, applied, unconfirmed,
  failed, closed`); skips and external leads are statuses, not tables.
  `stage` is what the employer did. A trigger derives it from `application_events`,
  so never write it directly; insert an event.
- `application_events`: outcomes and notes. `action_required and not action_done`
  is the "waiting on the human" queue. `(source, external_ref)` dedups imports such as Gmail ids.
- `answers`: reusable answer library. `key` names canonical facts (`notice_period`,
  `sponsorship.us`); null for ad-hoc answers. `status = provisional` means
  Claude-inferred and awaiting user confirmation. MCP writes set `source = 'claude'`.
- `application_questions`: per-application Q&A log, trigram-indexed for "asked this before?".
- `platform` values are free-form lowercase slugs (`linkedin`, `naukri`, `company_site`, ...).
- Signup trigger creates `profiles` + `preferences` rows. `profiles.email` is the
  contact email and is not synced with the auth email.
- Resume files live in private bucket `resumes` at `<user_id>/<resume_id>/<file_name>`.

## Open decisions

- OAuth is not yet Claude-connector compatible: no `/.well-known` metadata, PKCE,
  dynamic client registration or token revocation (tokens are 90-day stateless JWTs).
- `OAUTH_CLIENT_ID/SECRET` are unset in production, so any client id is accepted.
  Decide alongside the OAuth work.
- MCP tools don't enforce a subscription yet (`requireActiveSubscription` exists).
- The frontend uses the legacy anon JWT key; can move to the `sb_publishable_` key.
- Later: pgvector for semantic answer matching, an RPC for trigram question lookup,
  `org_id` if teams ever arrive.
