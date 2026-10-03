-- ============================================================================
-- Chrome extension channel (LinkedIn). docs/extension/BUILD-INSTRUCTIONS.md.
-- Additive only: no existing table, column, constraint, function or policy changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Devices: one row per installed extension the user approved. Listed and revoked
-- on the website like an MCP connection. Holds the current refresh token hash
-- (rotated on every refresh) and the one it replaced, to detect replay.
-- ----------------------------------------------------------------------------
create table public.ext_devices (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  name                      text not null check (char_length(name) between 1 and 60),
  ext_version               text,
  refresh_token_hash        text unique,
  refresh_token_expires_at  timestamptz,
  prev_refresh_token_hash   text,
  rotated_at                timestamptz,
  last_seen_at              timestamptz,
  revoked_at                timestamptz,
  metadata                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (id, user_id)
);
create index ext_devices_user on public.ext_devices (user_id, created_at desc);
create index ext_devices_prev_refresh on public.ext_devices (prev_refresh_token_hash)
  where prev_refresh_token_hash is not null;

-- ----------------------------------------------------------------------------
-- Pairing requests (device-code flow). Not user-owned until approved, so service
-- role only (RLS on, no policies). The user code is shown in the extension and
-- typed or confirmed on the website; the poll secret never leaves the extension.
-- ----------------------------------------------------------------------------
create table public.ext_pairings (
  id                uuid primary key default gen_random_uuid(),
  user_code         text not null unique check (user_code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  poll_secret_hash  text not null,
  device_name       text not null check (char_length(device_name) between 1 and 60),
  ext_version       text,
  user_id           uuid references auth.users (id) on delete cascade,
  device_id         uuid,
  approved_at       timestamptz,
  denied_at         timestamptz,
  consumed_at       timestamptz,
  last_polled_at    timestamptz,
  expires_at        timestamptz not null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  foreign key (device_id, user_id) references public.ext_devices (id, user_id) on delete cascade
);
create index ext_pairings_expires on public.ext_pairings (expires_at);
create index ext_pairings_user on public.ext_pairings (user_id) where user_id is not null;
create index ext_pairings_device on public.ext_pairings (device_id, user_id) where device_id is not null;

-- ----------------------------------------------------------------------------
-- Drafts: the server-side state of one LinkedIn draft (searches done, candidates,
-- JD queue, counters). The extension only executes the orders it is given.
-- ----------------------------------------------------------------------------
create table public.ext_drafts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  run_id         uuid not null,
  device_id      uuid not null,
  platform       text not null default 'linkedin' check (platform in ('linkedin')),
  status         text not null default 'searching'
                   check (status in ('searching', 'reading', 'done', 'stopped', 'failed')),
  posted_within  text not null check (posted_within in ('1h', '24h', '1w')),
  target         integer not null check (target between 1 and 100),
  state          jsonb not null default '{}'::jsonb,
  stats          jsonb not null default '{}'::jsonb,
  stop_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, user_id),
  foreign key (run_id, user_id)    references public.runs (id, user_id)        on delete cascade,
  foreign key (device_id, user_id) references public.ext_devices (id, user_id) on delete cascade
);
create index ext_drafts_user   on public.ext_drafts (user_id, created_at desc);
create index ext_drafts_run    on public.ext_drafts (run_id, user_id);
create index ext_drafts_device on public.ext_drafts (device_id, user_id);

-- ----------------------------------------------------------------------------
-- Leases: every unit of LinkedIn work handed to a device (a batch of search pages,
-- a batch of JD fetches, one job to apply to, one tracker read). At most one open
-- lease per user and platform, across devices and kinds (ext_issue_lease).
-- ----------------------------------------------------------------------------
create table public.ext_leases (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  device_id       uuid not null,
  run_id          uuid not null,
  platform        text not null check (platform in ('linkedin')),
  kind            text not null check (kind in ('search', 'jd', 'apply', 'tracker')),
  application_id  uuid,
  external_id     text,
  payload         jsonb not null default '{}'::jsonb,
  issued_at       timestamptz not null default now(),
  not_before      timestamptz not null,
  expires_at      timestamptz not null,
  completed_at    timestamptz,
  result          text,
  detail          jsonb not null default '{}'::jsonb,
  unique (id, user_id),
  foreign key (device_id, user_id)      references public.ext_devices (id, user_id)   on delete cascade,
  foreign key (run_id, user_id)         references public.runs (id, user_id)          on delete cascade,
  foreign key (application_id, user_id) references public.applications (id, user_id) on delete set null (application_id)
);
create index ext_leases_open        on public.ext_leases (user_id, platform, issued_at desc) where completed_at is null;
create index ext_leases_kind        on public.ext_leases (user_id, platform, kind, issued_at desc);
create index ext_leases_run         on public.ext_leases (run_id, user_id);
create index ext_leases_device      on public.ext_leases (device_id, user_id);
create index ext_leases_application on public.ext_leases (application_id, user_id) where application_id is not null;

-- One open lease per user and platform: sweep, prescreen and runner never overlap
-- (docs/automation-tools.md, Rate limits). The caller computes not_before (pacing);
-- this function only makes issuing atomic. Expired leases are closed by the caller first.
create or replace function public.ext_issue_lease(
  p_user_id        uuid,
  p_device_id      uuid,
  p_run_id         uuid,
  p_platform       text,
  p_kind           text,
  p_application_id uuid,
  p_external_id    text,
  p_payload        jsonb,
  p_not_before     timestamptz,
  p_ttl_seconds    integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_open public.ext_leases;
  v_new  public.ext_leases;
  v_at   timestamptz := greatest(p_not_before, now());
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_platform, 7));
  select * into v_open
    from public.ext_leases
   where user_id = p_user_id
     and platform = p_platform
     and completed_at is null
     and expires_at > now()
   order by issued_at desc
   limit 1;
  if found then
    return jsonb_build_object('issued', false, 'open_lease_id', v_open.id, 'device_id', v_open.device_id,
                              'kind', v_open.kind, 'expires_at', v_open.expires_at);
  end if;
  insert into public.ext_leases (user_id, device_id, run_id, platform, kind, application_id, external_id,
                                 payload, not_before, expires_at)
  values (p_user_id, p_device_id, p_run_id, p_platform, p_kind, p_application_id, p_external_id,
          coalesce(p_payload, '{}'::jsonb), v_at, v_at + make_interval(secs => p_ttl_seconds))
  returning * into v_new;
  return jsonb_build_object('issued', true, 'lease', to_jsonb(v_new));
end;
$$;

-- ----------------------------------------------------------------------------
-- Questions only the user can answer (a personal fact the data lacks, or a
-- protected fact a job requires). Answered once; the answer goes to answers and
-- every job waiting on it becomes applicable again.
-- ----------------------------------------------------------------------------
create table public.ext_questions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  question        text not null,
  question_norm   text not null,
  key             text check (key ~ '^[a-z0-9_.]+$'),
  kind            text not null check (kind in ('needs_input', 'protected')),
  field_type      text,
  options         jsonb,
  status          text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer_id       uuid,
  waiting         jsonb not null default '[]'::jsonb,
  times_seen      integer not null default 1 check (times_seen >= 1),
  last_seen_at    timestamptz not null default now(),
  answered_at     timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, question_norm),
  unique (id, user_id),
  foreign key (answer_id, user_id) references public.answers (id, user_id) on delete set null (answer_id)
);
create index ext_questions_open   on public.ext_questions (user_id, status, last_seen_at desc);
create index ext_questions_answer on public.ext_questions (answer_id, user_id) where answer_id is not null;

-- ----------------------------------------------------------------------------
-- AI resume profile: one structured profile per resume version (content hash).
-- ----------------------------------------------------------------------------
create table public.ext_resume_profiles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  resume_id       uuid not null,
  content_hash    text not null,
  profile         jsonb not null,
  model           text not null,
  prompt_version  text not null,
  created_at      timestamptz not null default now(),
  unique (resume_id, content_hash),
  foreign key (resume_id, user_id) references public.resumes (id, user_id) on delete cascade
);
create index ext_resume_profiles_user   on public.ext_resume_profiles (user_id, created_at desc);
create index ext_resume_profiles_resume on public.ext_resume_profiles (resume_id, user_id);

-- ----------------------------------------------------------------------------
-- AI usage and cost per user, day, purpose and model (budgets and reporting).
-- Cost is whole micro-dollars (USD).
-- ----------------------------------------------------------------------------
create table public.ext_ai_usage (
  user_id           uuid not null references auth.users (id) on delete cascade,
  day               date not null,
  purpose           text not null check (purpose in ('jd_facts', 'fit', 'resume_profile', 'answer', 'onboarding')),
  model             text not null,
  requests          integer not null default 0,
  input_cache_hit   bigint not null default 0,
  input_cache_miss  bigint not null default 0,
  output_tokens     bigint not null default 0,
  cost_micro_usd    bigint not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (user_id, day, purpose, model)
);

create or replace function public.ext_add_ai_usage(
  p_user_id uuid, p_day date, p_purpose text, p_model text,
  p_hit bigint, p_miss bigint, p_out bigint, p_cost bigint
)
returns void
language sql
set search_path = ''
as $$
  insert into public.ext_ai_usage as u
         (user_id, day, purpose, model, requests, input_cache_hit, input_cache_miss, output_tokens, cost_micro_usd)
  values (p_user_id, p_day, p_purpose, p_model, 1, p_hit, p_miss, p_out, p_cost)
  on conflict (user_id, day, purpose, model) do update
     set requests         = u.requests + 1,
         input_cache_hit  = u.input_cache_hit + excluded.input_cache_hit,
         input_cache_miss = u.input_cache_miss + excluded.input_cache_miss,
         output_tokens    = u.output_tokens + excluded.output_tokens,
         cost_micro_usd   = u.cost_micro_usd + excluded.cost_micro_usd,
         updated_at       = now();
$$;

-- ----------------------------------------------------------------------------
-- Shared posting cache: public job posting text and facts, one row per job, reused
-- across users. first_seen_by is recorded but never returned by any endpoint.
-- Service role only (RLS on, no policies).
-- ----------------------------------------------------------------------------
create table public.job_postings (
  platform         text not null check (platform ~ '^[a-z0-9_]+$'),
  external_id      text not null,
  title            text,
  company          text,
  location         text,
  seniority_level  text,
  ats              text,
  closed_seen_at   timestamptz,
  jd_text          text,
  jd_hash          text,
  jd_fetched_at    timestamptz,
  facts            jsonb not null default '{}'::jsonb,
  ai_facts         jsonb,
  ai_model         text,
  ai_version       text,
  first_seen_by    uuid references auth.users (id) on delete set null,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (platform, external_id),
  constraint job_postings_external_id_canonical check (
    case platform
      when 'linkedin'  then coalesce(external_id ~ '^[0-9]{6,15}$', false)
      when 'naukri'    then coalesce(external_id ~ '^[0-9]{10,14}$', false)
      when 'wellfound' then coalesce(external_id ~ '^[0-9]{3,12}$', false)
      when 'indeed'    then coalesce(external_id ~ '^[0-9a-f]{16}$', false)
      else true
    end
  )
);
create index job_postings_first_seen_by on public.job_postings (first_seen_by) where first_seen_by is not null;
create index job_postings_fetched       on public.job_postings (platform, jd_fetched_at desc);

-- ----------------------------------------------------------------------------
-- Extension events: a small log for debugging live runs (errors, stops, versions).
-- Never holds tokens or answer values. Pruned after 30 days by the cleanup cron.
-- ----------------------------------------------------------------------------
create table public.ext_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  device_id   uuid,
  run_id      uuid,
  level       text not null check (level in ('debug', 'info', 'warn', 'error')),
  type        text not null check (type ~ '^[a-z0-9_.]+$'),
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  foreign key (device_id, user_id) references public.ext_devices (id, user_id) on delete cascade,
  foreign key (run_id, user_id)    references public.runs (id, user_id)        on delete cascade
);
create index ext_events_user   on public.ext_events (user_id, created_at desc);
create index ext_events_device on public.ext_events (device_id, user_id) where device_id is not null;
create index ext_events_run    on public.ext_events (run_id, user_id) where run_id is not null;
create index ext_events_created on public.ext_events (created_at);

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
create trigger set_updated_at before update on public.ext_devices   for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.ext_drafts    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.ext_questions for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.job_postings  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: on everywhere; users may read their own rows; writes are service role only.
-- ----------------------------------------------------------------------------
alter table public.ext_devices          enable row level security;
alter table public.ext_pairings         enable row level security;
alter table public.ext_drafts           enable row level security;
alter table public.ext_leases           enable row level security;
alter table public.ext_questions        enable row level security;
alter table public.ext_resume_profiles  enable row level security;
alter table public.ext_ai_usage         enable row level security;
alter table public.job_postings         enable row level security;
alter table public.ext_events           enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ext_devices', 'ext_drafts', 'ext_leases', 'ext_questions',
                           'ext_resume_profiles', 'ext_ai_usage', 'ext_events']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Server-only helpers
-- ----------------------------------------------------------------------------
revoke execute on function public.ext_issue_lease(uuid, uuid, uuid, text, text, uuid, text, jsonb, timestamptz, integer)
  from public, anon, authenticated;
revoke execute on function public.ext_add_ai_usage(uuid, date, text, text, bigint, bigint, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.ext_issue_lease(uuid, uuid, uuid, text, text, uuid, text, jsonb, timestamptz, integer)
  to service_role;
grant execute on function public.ext_add_ai_usage(uuid, date, text, text, bigint, bigint, bigint, bigint)
  to service_role;
