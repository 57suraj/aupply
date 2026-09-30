/**
 * Aupply — Complete Database Schema
 *
 * Run this against your Supabase project via the SQL editor or Supabase CLI.
 *
 * This schema is designed to work with Supabase Auth:
 *   - User identity comes from auth.users (managed by Supabase Auth).
 *   - All user-owned tables reference the Supabase Auth user ID via user_id.
 *   - RLS is enabled on all user-owned tables.
 *   - A trigger automatically creates a profile row when a new user signs up.
 *
 * Web users authenticate via Supabase Auth (VITE_SUPABASE_ANON_KEY on frontend).
 * MCP users authenticate via our OAuth server (JWT sub = Supabase Auth user ID).
 * Both paths result in the same user_id for DB queries.
 *
 * NOT yet in schema (future phases):
 *   - Resume file storage (Supabase Storage)
 *   - Vector embeddings
 *   - Job listings
 *   - Job matching / scoring
 */

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USER PROFILES
-- ============================================================
-- Extended profile data for users authenticated via Supabase Auth.
-- The id column MUST match auth.users.id.
-- Populated automatically by the handle_new_user trigger below.
CREATE TABLE IF NOT EXISTS public.users (
  id            UUID PRIMARY KEY,           -- matches auth.users.id
  email         TEXT,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- RESUMES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.resumes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,                -- references auth.users.id
  content    TEXT,                         -- parsed resume text
  file_name  TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access their own resumes" ON public.resumes;
CREATE POLICY "Users can access their own resumes"
  ON public.resumes FOR ALL
  USING (user_id = auth.uid());

-- ============================================================
-- PREFERENCES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.preferences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE,
  desired_roles       TEXT[],
  desired_locations   TEXT[],
  preferred_companies TEXT[],
  exclude_companies   TEXT[],
  min_salary          INTEGER,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access their own preferences" ON public.preferences;
CREATE POLICY "Users can access their own preferences"
  ON public.preferences FOR ALL
  USING (user_id = auth.uid());

-- ============================================================
-- APPLICATION HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS public.application_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  company_name  TEXT,
  job_title     TEXT,
  job_url       TEXT,
  status        TEXT NOT NULL DEFAULT 'applied',
  applied_at    TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.application_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access their own application history" ON public.application_history;
CREATE POLICY "Users can access their own application history"
  ON public.application_history FOR ALL
  USING (user_id = auth.uid());

-- ============================================================
-- ANSWERS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.answers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access their own answers" ON public.answers;
CREATE POLICY "Users can access their own answers"
  ON public.answers FOR ALL
  USING (user_id = auth.uid());

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================
-- Populated exclusively by the Stripe webhook handler (server-side).
-- The frontend NEVER writes to this table.
-- status values: active | trialing | past_due | canceled | inactive
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL,               -- auth.users.id
  stripe_customer_id        TEXT,
  stripe_subscription_id    TEXT UNIQUE,                 -- used for upsert
  stripe_price_id           TEXT,
  status                    TEXT NOT NULL DEFAULT 'inactive',
  current_period_end        TIMESTAMPTZ,
  cancel_at_period_end      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can read their own subscription (for the account page)
DROP POLICY IF EXISTS "Users can read their own subscription" ON public.subscriptions;
CREATE POLICY "Users can read their own subscription"
  ON public.subscriptions FOR SELECT
  USING (user_id = auth.uid());

-- Only the service role (backend) can insert/update subscriptions
-- (RLS implicitly blocks writes from anon/authenticated roles)
-- The backend uses the service-role key which bypasses RLS.

-- Index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_application_history_user_id ON public.application_history(user_id);
CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON public.resumes(user_id);
CREATE INDEX IF NOT EXISTS idx_answers_user_id ON public.answers(user_id);
