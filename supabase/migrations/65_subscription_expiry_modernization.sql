-- =============================================================================
-- 65_subscription_expiry_modernization.sql
-- -----------------------------------------------------------------------------
-- Modernizes plan-expiry handling for B2B school deals. Today's gaps:
--
--   * The clock starts the moment the platform admin clicks Save in the
--     onboarding form. If the school's Admin Head doesn't sign in for a
--     week, they've already lost a week of value.
--
--   * On the day expires_at flips past, every premium feature goes dark
--     instantly. No grace, no chase window. That's a worse experience
--     than what every modern SaaS gives.
--
--   * Indian schools sign B2B contracts in March/April for an academic
--     year that starts in June — but our schema can't represent "starts
--     1 June, ends 31 May" without doing the maths externally.
--
-- This migration adds three columns to fix those:
--
--   1. grace_period_days — default 14. Features keep working from
--      expires_at to expires_at + grace; the renew banner turns red and
--      mailto-driven during that window. After grace, hard cutoff.
--
--   2. activation_pending — boolean. When true, started_at / expires_at
--      are placeholders; they're recomputed on the school's first
--      super_teacher sign-in and the flag flips to false. Solves the
--      onboarding-lag scenario.
--
--   3. Optional: started_at is already a column, but until now nobody
--      ever wrote it explicitly — it was always now(). The new set-plan
--      endpoint accepts an explicit started_at body field, so a school
--      can be onboarded in March with a 1 June start date.
-- =============================================================================

alter table public.subscriptions
  add column if not exists grace_period_days integer default 14
    check (grace_period_days is null or grace_period_days >= 0),
  add column if not exists activation_pending boolean default false not null;

comment on column public.subscriptions.grace_period_days is
  'Soft-grace window after expires_at during which the school still has full feature access but sees a red renewal banner. Default 14. Beyond this, hard cutoff.';

comment on column public.subscriptions.activation_pending is
  'When true, started_at + expires_at are placeholders set to onboarding time; the real values are computed on the school super_teacher''s first sign-in and this flag flips to false. Lets the platform admin onboard a school early without consuming term days.';

-- Backfill: every existing row gets the default grace (14 days) so the
-- behavior change is universal, not "only schools onboarded after today".
update public.subscriptions
  set grace_period_days = 14
  where grace_period_days is null;

notify pgrst, 'reload schema';
