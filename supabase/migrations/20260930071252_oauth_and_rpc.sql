-- ============================================================================
-- OAuth 2.1 authorization server storage (Claude connector auth) and
-- server-side query helpers used by the MCP tools and the dashboard API.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- oauth_clients: dynamically registered clients (RFC 7591), e.g. Claude.
-- Not user-owned. Service role only (RLS on, no policies).
-- client_secret is stored as issued because the MCP SDK compares it verbatim;
-- public clients (token_endpoint_auth_method = 'none') have none.
-- ----------------------------------------------------------------------------
create table public.oauth_clients (
  id                          text primary key,          -- client_id
  client_secret               text,
  client_secret_expires_at    bigint,                    -- epoch seconds, 0 = never
  client_id_issued_at         bigint not null,
  client_name                 text,
  redirect_uris               text[] not null,
  token_endpoint_auth_method  text not null default 'none',
  metadata                    jsonb not null default '{}'::jsonb,  -- full registration response
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- oauth_grants: one row per (user, client) authorization = a "connection".
-- Holds the current refresh token hash (rotated on every refresh).
-- Access tokens carry the grant id and are rejected once revoked_at is set.
-- ----------------------------------------------------------------------------
create table public.oauth_grants (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  client_id                 text not null references public.oauth_clients (id) on delete cascade,
  scopes                    text[] not null default '{}',
  resource                  text,
  refresh_token_hash        text unique,
  refresh_token_expires_at  timestamptz,
  last_used_at              timestamptz,
  revoked_at                timestamptz,
  metadata                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index oauth_grants_user   on public.oauth_grants (user_id, created_at desc);
create index oauth_grants_client on public.oauth_grants (client_id);

-- ----------------------------------------------------------------------------
-- oauth_authorization_codes: single-use, short-lived, stored hashed.
-- grant_id is set on exchange so a replayed code can revoke what it minted.
-- ----------------------------------------------------------------------------
create table public.oauth_authorization_codes (
  code_hash       text primary key,
  client_id       text not null references public.oauth_clients (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  scopes          text[] not null default '{}',
  resource        text,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  grant_id        uuid references public.oauth_grants (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index oauth_codes_client  on public.oauth_authorization_codes (client_id);
create index oauth_codes_user    on public.oauth_authorization_codes (user_id);
create index oauth_codes_grant   on public.oauth_authorization_codes (grant_id) where grant_id is not null;
create index oauth_codes_expires on public.oauth_authorization_codes (expires_at);

create trigger set_updated_at before update on public.oauth_clients for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.oauth_grants  for each row execute function public.set_updated_at();

alter table public.oauth_clients             enable row level security;
alter table public.oauth_grants              enable row level security;
alter table public.oauth_authorization_codes enable row level security;

create policy "oauth_grants_select_own" on public.oauth_grants
  for select to authenticated using ((select auth.uid()) = user_id);

-- ============================================================================
-- Server-only query helpers. Each takes the user id explicitly, so they are
-- callable by the service role only (never exposed to anon/authenticated).
-- ============================================================================

-- Saved answers + previously given application answers similar to a question.
create or replace function public.find_similar_answers(
  p_user_id   uuid,
  p_query     text,
  p_limit     integer default 5,
  p_min_score real default 0.3
)
returns table (
  source        text,
  id            uuid,
  key           text,
  question      text,
  answer        text,
  status        text,
  company_name  text,
  job_title     text,
  score         real,
  last_used_at  timestamptz
)
language sql
stable
set search_path = ''
as $$
  select s.*
    from (
      select 'saved'::text, a.id, a.key, a.question, a.answer, a.status,
             null::text, null::text,
             greatest(extensions.similarity(a.question, p_query),
                      extensions.word_similarity(p_query, a.question)),
             coalesce(a.last_used_at, a.updated_at)
        from public.answers a
       where a.user_id = p_user_id
      union all
      select 'history'::text, q.id, null::text, q.question, q.answer, null::text,
             ap.company_name, ap.job_title,
             greatest(extensions.similarity(q.question, p_query),
                      extensions.word_similarity(p_query, q.question)),
             q.created_at
        from public.application_questions q
        join public.applications ap on ap.id = q.application_id and ap.user_id = q.user_id
       where q.user_id = p_user_id
         and q.answer is not null
    ) as s (source, id, key, question, answer, status, company_name, job_title, score, last_used_at)
   where s.score >= p_min_score
   order by s.score desc, (s.source = 'saved') desc, s.last_used_at desc nulls last
   limit least(greatest(p_limit, 1), 50);
$$;

-- Dedup before applying: which job ids / companies has this user already touched?
create or replace function public.check_existing_applications(
  p_user_id       uuid,
  p_platform      text,
  p_external_ids  text[],
  p_companies     text[]
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'platform', a.platform, 'external_id', a.external_id,
               'company_name', a.company_name, 'job_title', a.job_title,
               'status', a.status, 'stage', a.stage, 'applied_at', a.applied_at))
        from public.applications a
       where a.user_id = p_user_id
         and (p_platform is null or a.platform = p_platform)
         and a.external_id = any(coalesce(p_external_ids, '{}'))
    ), '[]'::jsonb),
    'companies', coalesce((
      select jsonb_agg(c.row)
        from (
          select jsonb_build_object(
                   'company_name', min(a.company_name),
                   'applications', count(*),
                   'submitted', count(*) filter (where a.status in ('applied', 'unconfirmed')),
                   'last_status', (array_agg(a.status order by a.created_at desc))[1],
                   'last_activity_at', max(a.updated_at)) as row
            from public.applications a
           where a.user_id = p_user_id
             and lower(a.company_name) in (select lower(x) from unnest(coalesce(p_companies, '{}')) as x)
           group by lower(a.company_name)
        ) as c
    ), '[]'::jsonb)
  );
$$;

-- Funnel numbers for the dashboard and end-of-run summaries.
create or replace function public.application_stats(p_user_id uuid, p_tz text default 'UTC')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with apps as (
    select * from public.applications where user_id = p_user_id
  ),
  submitted as (
    select * from apps where status in ('applied', 'unconfirmed')
  )
  select jsonb_build_object(
    'total',            (select count(*) from apps),
    'submitted',        (select count(*) from submitted),
    'submitted_today',  (select count(*) from submitted
                          where (applied_at at time zone p_tz)::date = (now() at time zone p_tz)::date),
    'submitted_7d',     (select count(*) from submitted where applied_at >= now() - interval '7 days'),
    'submitted_30d',    (select count(*) from submitted where applied_at >= now() - interval '30 days'),
    'responded',        (select count(*) from submitted where stage <> 'none'),
    'by_status',        coalesce((select jsonb_object_agg(status, n)
                                    from (select status, count(*) as n from apps group by status) s), '{}'::jsonb),
    'by_stage',         coalesce((select jsonb_object_agg(stage, n)
                                    from (select stage, count(*) as n from submitted group by stage) s), '{}'::jsonb),
    'by_platform',      coalesce((select jsonb_object_agg(platform, n)
                                    from (select platform, count(*) as n from submitted group by platform) s), '{}'::jsonb),
    'pending_actions',  (select count(*) from public.application_events e
                          where e.user_id = p_user_id and e.action_required and not e.action_done)
  );
$$;

-- Bump usage counters on saved answers that were reused.
create or replace function public.mark_answers_used(p_user_id uuid, p_answer_ids uuid[])
returns void
language sql
set search_path = ''
as $$
  update public.answers
     set times_used = times_used + 1,
         last_used_at = now()
   where user_id = p_user_id
     and id = any(p_answer_ids);
$$;

revoke execute on function public.find_similar_answers(uuid, text, integer, real)            from public, anon, authenticated;
revoke execute on function public.check_existing_applications(uuid, text, text[], text[])    from public, anon, authenticated;
revoke execute on function public.application_stats(uuid, text)                              from public, anon, authenticated;
revoke execute on function public.mark_answers_used(uuid, uuid[])                            from public, anon, authenticated;
grant  execute on function public.find_similar_answers(uuid, text, integer, real)            to service_role;
grant  execute on function public.check_existing_applications(uuid, text, text[], text[])    to service_role;
grant  execute on function public.application_stats(uuid, text)                              to service_role;
grant  execute on function public.mark_answers_used(uuid, uuid[])                            to service_role;
