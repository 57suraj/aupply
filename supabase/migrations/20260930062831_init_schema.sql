-- ============================================================================
-- Aupply: initial schema
--
-- Conventions (keep these for every future table; see claude.md):
--   * Every user-owned row has user_id -> auth.users(id) ON DELETE CASCADE.
--   * Child tables reference parents with a composite FK (parent_id, user_id),
--     so a row can never point at another user's parent, even via service role.
--   * Enum-like columns are text + CHECK. To add a value, replace the
--     constraint in a new migration (and update the matching zod enum).
--   * Every table has metadata jsonb for fields not yet promoted to columns.
--   * Money is bigint whole currency units + ISO-4217 currency + period.
--   * RLS on everything. The browser (anon key) only ever sees its own rows;
--     the Express backend uses the service role and must scope by user_id.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

-- ----------------------------------------------------------------------------
-- Shared trigger: keep updated_at current
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- PROFILES: one row per user, candidate identity and contact details
-- ============================================================================
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text,          -- contact email for applications; seeded from auth, user-editable
  full_name           text,
  preferred_name      text,
  phone               text,          -- E.164 where possible, e.g. +919876543210
  headline            text,          -- one-line professional title
  summary             text,          -- short professional pitch
  location_city       text,
  location_region     text,
  location_country    text,
  timezone            text,          -- IANA name, e.g. Asia/Kolkata
  links               jsonb not null default '{}'::jsonb,  -- {"linkedin": "...", "github": "...", "portfolio": "..."}
  current_title       text,
  current_company     text,
  years_experience    numeric(4,1) check (years_experience >= 0),
  current_salary          bigint check (current_salary >= 0),
  current_salary_currency text check (current_salary_currency ~ '^[A-Z]{3}$'),
  current_salary_period   text not null default 'year' check (current_salary_period in ('year', 'month', 'hour')),
  notice_period_days  integer check (notice_period_days >= 0),
  earliest_start_date date,
  skills              text[] not null default '{}',
  languages           text[] not null default '{}',
  onboarded_at        timestamptz,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.profiles is
  'Candidate identity. 1:1 with auth.users, created by the on_auth_user_created trigger.';

-- ============================================================================
-- WORK EXPERIENCES and EDUCATIONS: structured history, many per user
-- ============================================================================
create table public.work_experiences (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  company         text not null,
  title           text not null,
  employment_type text,              -- full_time, internship, contract, ...
  location        text,
  start_date      date,
  end_date        date,
  is_current      boolean not null default false,
  description     text,
  highlights      text[] not null default '{}',
  skills          text[] not null default '{}',
  sort_order      integer not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table public.educations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  institution     text not null,
  degree          text,
  field_of_study  text,
  start_date      date,
  end_date        date,
  grade           text,              -- as stated: "8.6", "75%", "First class"
  grade_scale     text,              -- "10", "100", "4.0"
  description     text,
  sort_order      integer not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

-- ============================================================================
-- RESUMES: versioned, several variants per user, exactly one default
-- ============================================================================
create table public.resumes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  label           text not null default 'Resume',   -- e.g. "Full-stack", "AI/ML"
  content         text,              -- parsed text/markdown handed to Claude
  structured      jsonb,             -- optional parsed sections
  file_path       text,              -- object path in storage bucket 'resumes': <user_id>/<resume_id>/<file_name>
  file_name       text,
  mime_type       text,
  file_size_bytes bigint check (file_size_bytes >= 0),
  is_default      boolean not null default false,
  archived_at     timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, user_id)
);

create unique index resumes_one_default_per_user
  on public.resumes (user_id) where is_default;

-- Setting a resume as default quietly un-defaults the previous one,
-- so callers never trip the partial unique index above.
create or replace function public.resumes_single_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.resumes
     set is_default = false
   where user_id = new.user_id
     and id <> new.id
     and is_default;
  return new;
end;
$$;

create trigger resumes_single_default
  before insert or update of is_default on public.resumes
  for each row when (new.is_default)
  execute function public.resumes_single_default();

-- ============================================================================
-- PREFERENCES: one row per user, what to apply to and how
-- ============================================================================
create table public.preferences (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  desired_roles           text[] not null default '{}',
  seniority_levels        text[] not null default '{}',   -- junior, mid, senior, ...
  desired_locations       text[] not null default '{}',
  work_modes              text[] not null default '{}',   -- remote, hybrid, onsite
  employment_types        text[] not null default '{}',   -- full_time, contract, internship
  willing_to_relocate     boolean,
  min_salary              bigint check (min_salary >= 0),       -- floor: skip anything below
  expected_salary         bigint check (expected_salary >= 0),  -- what to state when asked
  salary_currency         text check (salary_currency ~ '^[A-Z]{3}$'),
  salary_period           text not null default 'year' check (salary_period in ('year', 'month', 'hour')),
  max_years_required      numeric(4,1) check (max_years_required >= 0),  -- skip postings asking for more
  include_keywords        text[] not null default '{}',
  exclude_keywords        text[] not null default '{}',   -- stacks/terms to skip
  preferred_companies     text[] not null default '{}',
  excluded_companies      text[] not null default '{}',
  platforms               text[] not null default '{}',   -- enabled channels: linkedin, wellfound, naukri, ...
  max_posting_age_hours   integer check (max_posting_age_hours > 0),
  daily_application_limit integer check (daily_application_limit > 0),
  notes                   text,              -- free-form instructions for Claude
  rules                   jsonb not null default '{}'::jsonb,  -- per-platform / advanced settings
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ============================================================================
-- ANSWERS: the reusable answer library (save_answer writes here)
--   key: optional stable slug for canonical facts (notice_period,
--        sponsorship.us, ...). Ad-hoc saved answers leave it null.
--   status: 'provisional' = inferred by Claude, not yet confirmed by the user.
-- ============================================================================
create table public.answers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  key           text check (key ~ '^[a-z0-9_.]+$'),
  question      text not null,
  answer        text not null,
  category      text,                -- experience, compensation, availability, eligibility, eeo, long_form, ...
  tags          text[] not null default '{}',
  status        text not null default 'confirmed' check (status in ('confirmed', 'provisional')),
  source        text not null default 'user' check (source in ('user', 'claude', 'import')),
  times_used    integer not null default 0 check (times_used >= 0),
  last_used_at  timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, key),
  unique (id, user_id)
);

create index answers_question_trgm
  on public.answers using gin (question extensions.gin_trgm_ops);

-- ============================================================================
-- RUNS: one row per Claude application session, for throughput over time
-- ============================================================================
create table public.runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  client      text,                  -- claude_ai, claude_code, ...
  summary     text,
  stats       jsonb not null default '{}'::jsonb,   -- e.g. {"linkedin": {"applied": 35}, ...}
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, user_id)
);

create index runs_user_started on public.runs (user_id, started_at desc);

-- ============================================================================
-- APPLICATIONS: every job the user (or Claude) touched, one row per job.
--   Dedup key: (user_id, platform, external_id).
--   status = what WE did:   discovered | lead | skipped | parked | applied |
--                           unconfirmed | failed | closed
--   stage  = what THEY did: derived from application_events, never set by hand.
-- ============================================================================
create table public.applications (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  platform              text not null check (platform ~ '^[a-z0-9_]+$'),  -- linkedin, wellfound, naukri, indeed, company_site, ...
  external_id           text,          -- the platform's own job id
  job_url               text,
  company_name          text not null,
  job_title             text not null,
  location              text,
  work_mode             text check (work_mode in ('remote', 'hybrid', 'onsite')),
  employment_type       text,
  salary_min            bigint check (salary_min >= 0),
  salary_max            bigint check (salary_max >= 0),
  salary_currency       text check (salary_currency ~ '^[A-Z]{3}$'),
  salary_period         text check (salary_period in ('year', 'month', 'hour')),
  salary_text           text,          -- raw string as posted
  experience_min_years  numeric(4,1) check (experience_min_years >= 0),
  experience_max_years  numeric(4,1) check (experience_max_years >= 0),
  job_description       text,          -- JD snapshot at time of applying
  posted_at             timestamptz,
  status                text not null default 'discovered'
                          check (status in ('discovered', 'lead', 'skipped', 'parked', 'applied',
                                            'unconfirmed', 'failed', 'closed')),
  status_reason         text,          -- why skipped / parked / failed / worth doing by hand
  stage                 text not null default 'none'
                          check (stage in ('none', 'acknowledged', 'screening', 'assessment', 'interview',
                                           'offer', 'hired', 'rejected', 'withdrawn', 'ghosted')),
  applied_at            timestamptz,
  match_score           numeric(5,2) check (match_score between 0 and 100),
  resume_id             uuid,
  run_id                uuid,
  cover_note            text,
  source                text,          -- how it was found: search, alert_email, referral, manual
  notes                 text,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, platform, external_id),
  unique (id, user_id),
  check (salary_max is null or salary_min is null or salary_max >= salary_min),
  foreign key (resume_id, user_id) references public.resumes (id, user_id) on delete set null (resume_id),
  foreign key (run_id, user_id)    references public.runs (id, user_id)    on delete set null (run_id)
);

create index applications_user_status   on public.applications (user_id, status);
create index applications_user_stage    on public.applications (user_id, stage);
create index applications_user_applied  on public.applications (user_id, applied_at desc);
create index applications_user_company  on public.applications (user_id, lower(company_name));
create index applications_resume        on public.applications (resume_id, user_id) where resume_id is not null;
create index applications_run           on public.applications (run_id, user_id)    where run_id is not null;

-- Stamp applied_at the first time a row reaches applied/unconfirmed.
create or replace function public.applications_set_applied_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('applied', 'unconfirmed') and new.applied_at is null then
    new.applied_at := now();
  end if;
  return new;
end;
$$;

create trigger applications_set_applied_at
  before insert or update of status on public.applications
  for each row execute function public.applications_set_applied_at();

-- ============================================================================
-- APPLICATION EVENTS: everything that came back (emails, interviews, offers,
-- rejections, requests for info) plus notes. Feeds applications.stage.
--   application_id may be null for events not yet matched to a job.
--   (user_id, source, external_ref) dedups imports, e.g. Gmail message ids.
-- ============================================================================
create table public.application_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  application_id  uuid,
  type            text not null
                    check (type in ('acknowledged', 'screening', 'assessment', 'interview', 'offer',
                                    'hired', 'rejected', 'withdrawn', 'ghosted',
                                    'info_request', 'message', 'note')),
  occurred_at     timestamptz not null default now(),
  source          text not null default 'manual' check (source ~ '^[a-z0-9_]+$'),  -- gmail, platform, claude, manual
  external_ref    text,
  company_name    text,
  subject         text,
  detail          text,
  action_required boolean not null default false,
  action_done     boolean not null default false,
  action_due_at   timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, source, external_ref),
  foreign key (application_id, user_id) references public.applications (id, user_id) on delete cascade
);

create index application_events_user_occurred on public.application_events (user_id, occurred_at desc);
create index application_events_application   on public.application_events (application_id, user_id)
  where application_id is not null;
create index application_events_open_actions  on public.application_events (user_id, occurred_at desc)
  where action_required and not action_done;

-- applications.stage = type of the most recent stage-bearing event.
create or replace function public.recompute_application_stage(p_application_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.applications a
     set stage = coalesce((
           select e.type
             from public.application_events e
            where e.application_id = p_application_id
              and e.type in ('acknowledged', 'screening', 'assessment', 'interview', 'offer',
                             'hired', 'rejected', 'withdrawn', 'ghosted')
            order by e.occurred_at desc, e.created_at desc
            limit 1), 'none')
   where a.id = p_application_id;
$$;

create or replace function public.application_events_sync_stage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.application_id is not null then
    perform public.recompute_application_stage(new.application_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.application_id is not null
     and (tg_op = 'DELETE' or old.application_id is distinct from new.application_id) then
    perform public.recompute_application_stage(old.application_id);
  end if;
  return null;
end;
$$;

create trigger application_events_sync_stage
  after insert or delete or update of type, occurred_at, application_id on public.application_events
  for each row execute function public.application_events_sync_stage();

-- ============================================================================
-- APPLICATION QUESTIONS: every screening question seen on an application and
-- the answer given. Append-only log; trigram-indexed for "asked this before?".
-- ============================================================================
create table public.application_questions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  application_id  uuid not null,
  question        text not null,
  answer          text,
  field_type      text,              -- text, textarea, select, radio, checkbox, number, date, file
  options         jsonb,             -- choices offered, if any
  answer_id       uuid,              -- saved answer that was reused, if any
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  foreign key (application_id, user_id) references public.applications (id, user_id) on delete cascade,
  foreign key (answer_id, user_id)      references public.answers (id, user_id)      on delete set null (answer_id)
);

create index application_questions_application on public.application_questions (application_id, user_id);
create index application_questions_answer      on public.application_questions (answer_id, user_id)
  where answer_id is not null;
create index application_questions_user        on public.application_questions (user_id, created_at desc);
create index application_questions_question_trgm
  on public.application_questions using gin (question extensions.gin_trgm_ops);

-- ============================================================================
-- SUBSCRIPTIONS: written only by the Stripe webhook (service role).
--   status mirrors Stripe verbatim, deliberately unconstrained so a new Stripe
--   status can never make the webhook fail.
-- ============================================================================
create table public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users (id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  stripe_price_id         text,
  status                  text not null default 'inactive',
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  metadata                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index subscriptions_user     on public.subscriptions (user_id, created_at desc);
create index subscriptions_customer on public.subscriptions (stripe_customer_id);

-- ============================================================================
-- Remaining user_id indexes (tables whose unique keys don't already lead with it)
-- ============================================================================
create index work_experiences_user on public.work_experiences (user_id, sort_order);
create index educations_user       on public.educations (user_id, sort_order);
create index resumes_user          on public.resumes (user_id, created_at desc);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create trigger set_updated_at before update on public.profiles           for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.work_experiences   for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.educations         for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.resumes            for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.preferences        for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.answers            for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.runs               for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.applications       for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.application_events for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.subscriptions      for each row execute function public.set_updated_at();

-- ============================================================================
-- New user bootstrap: profile + empty preferences row
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), '')
  )
  on conflict (id) do nothing;

  insert into public.preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles              enable row level security;
alter table public.work_experiences      enable row level security;
alter table public.educations            enable row level security;
alter table public.resumes               enable row level security;
alter table public.preferences           enable row level security;
alter table public.answers               enable row level security;
alter table public.runs                  enable row level security;
alter table public.applications          enable row level security;
alter table public.application_events    enable row level security;
alter table public.application_questions enable row level security;
alter table public.subscriptions         enable row level security;

-- profiles: read/update own row (created by trigger, deleted by cascade)
create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- preferences: read/insert/update own row
create policy "preferences_select_own" on public.preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "preferences_insert_own" on public.preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "preferences_update_own" on public.preferences
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- subscriptions: read own; writes are service-role only
create policy "subscriptions_select_own" on public.subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);

-- full CRUD on own rows for the remaining user-owned tables
do $$
declare
  t text;
begin
  foreach t in array array[
    'work_experiences', 'educations', 'resumes', 'answers', 'runs',
    'applications', 'application_events', 'application_questions'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      t || '_delete_own', t);
  end loop;
end;
$$;
