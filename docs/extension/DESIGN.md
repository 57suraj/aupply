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
| 2. `/ext` function, auth, devices | not started |
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

## Deviations from the plan

None so far.

## Open issues

None so far.
