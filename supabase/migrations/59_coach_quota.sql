-- =============================================================================
-- 59_coach_quota.sql
-- -----------------------------------------------------------------------------
-- Tier-based monthly quota for the Coach surfaces (Teacher Coach +
-- School/Principal Coach). Until now these were ungated — any user
-- with the right role got unlimited Coach access. Plan tiering for
-- the AI-driven features is the canonical upsell hook for BloomIQ.
--
-- Limits per plan slug (resolved by the API route, not enforced in
-- this migration):
--
--   school_pilot     →  0  (no Coach access)
--   school_standard  →  50 questions per rolling 30 days
--   school_plus      →  unlimited
--
--   premium / premium_plus / personal plans → out of scope here
--   (this migration is for school plans; personal plans don't have
--   a Coach surface yet).
--
-- This migration only adds the LOG table and an RLS policy. The
-- API route counts rows, compares to the tier limit, and returns
-- 402 when exceeded. Keeping the limit in code (not the DB) lets
-- us tune it without a migration cycle.
-- =============================================================================

create table if not exists public.coach_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Which Coach surface invoked this — 'teacher' for /teacher/coach,
  -- 'school' for /school/coach. Lets us distinguish quotas later
  -- if we want to (currently both consume the same monthly bucket
  -- per user, which matches the "one user, one quota" mental model
  -- the principal's plan offers).
  surface text not null check (surface in ('teacher', 'school')),
  called_at timestamptz not null default now()
);

-- Hot index: the only query the API runs is "count rows for this
-- user in the last 30 days". (user_id, called_at desc) covers it
-- perfectly and lets the count short-circuit on the index.
create index if not exists coach_usage_user_called_idx
  on public.coach_usage (user_id, called_at desc);

alter table public.coach_usage enable row level security;

-- Users can read their own usage rows (so the UI can render
-- "you've used 12 of 50 questions this month"). They can NOT
-- insert directly — only the service-role client used by the
-- API routes inserts, after the gate has been checked.
drop policy if exists "coach_usage read self" on public.coach_usage;
create policy "coach_usage read self" on public.coach_usage
  for select using (user_id = auth.uid());

-- Service role bypasses RLS for inserts; no insert policy needed
-- for end users.

notify pgrst, 'reload schema';
