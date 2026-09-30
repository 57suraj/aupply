-- Automation tools (docs/automation-tools.md).
--
-- 1. Canonical job ids. The scripted platforms must carry the platform's own job id in
--    canonical form, so (user_id, platform, external_id) dedups reliably. A NULL id
--    would slip past the unique constraint (NULLs are distinct), so it is refused too.
--    src/platforms/ids.ts produces these forms from ids, URLs and URNs.
alter table public.applications
  add constraint applications_external_id_canonical check (
    case platform
      when 'linkedin'  then coalesce(external_id ~ '^[0-9]{6,15}$', false)
      when 'naukri'    then coalesce(external_id ~ '^[0-9]{10,14}$', false)
      when 'wellfound' then coalesce(external_id ~ '^[0-9]{3,12}$', false)
      when 'indeed'    then coalesce(external_id ~ '^[0-9a-f]{16}$', false)
      else true
    end
  );

-- The queue: discovered jobs per platform, best first. Also serves the daily-cap count
-- (platform + applied_at) through applications_user_applied.
create index applications_queue
  on public.applications (user_id, platform, match_score desc nulls last, created_at)
  where status = 'discovered';

-- 2. Platform state: rate-limit backoffs and small per-platform state (Naukri refresh
--    chip, LinkedIn tracker count, Wellfound failure streak). One row per user and
--    scope; scopes are platforms plus sub-scopes such as linkedin_guest (the guest API
--    has its own limits). Written only by the server; the tools refuse to issue a
--    script while blocked_until is in the future.
create table public.platform_state (
  user_id       uuid not null references auth.users (id) on delete cascade,
  platform      text not null check (platform ~ '^[a-z0-9_]+$'),
  blocked_until timestamptz,
  block_reason  text,
  state         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, platform)
);

comment on table public.platform_state is
  'Per-user, per-platform automation state: rate-limit backoffs (blocked_until) and small machine state.';

create trigger set_updated_at before update on public.platform_state
  for each row execute function public.set_updated_at();

alter table public.platform_state enable row level security;

create policy "platform_state_select_own" on public.platform_state
  for select to authenticated using ((select auth.uid()) = user_id);
