-- Saved for manual apply, and who submitted an application.
--
-- 1. status 'saved': a strong match Aupply cannot apply to (not Easy Apply), kept for the user
--    to apply to by hand from the dashboard. status_reason still says it is not Easy Apply.
-- 2. applied_by: who submitted it. 'aupply' (an engine or Claude), 'user' (by hand, from the
--    dashboard's Apply); null when unknown (rows from before this column, or a job the platform
--    already showed as applied). A manual apply is not an Easy Apply submission, so the LinkedIn
--    daily cap and the tracker check leave applied_by = 'user' out.

alter table public.applications drop constraint applications_status_check;
alter table public.applications add constraint applications_status_check
  check (status in ('discovered', 'lead', 'saved', 'skipped', 'parked', 'applied',
                    'unconfirmed', 'failed', 'closed'));

alter table public.applications
  add column applied_by text check (applied_by in ('aupply', 'user'));
