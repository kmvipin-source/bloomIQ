-- =============================================================================
-- 67_free_trial_days.sql
-- -----------------------------------------------------------------------------
-- Adds an admin-controlled Free-plan validity window. When the platform admin
-- sets subscription_limits.free_trial_days > 0 (default 7), every brand-new
-- independent student (no school_id, role='student') is auto-granted a
-- TIME-BOXED FREE PLAN on first sign-in: tier='free', is_trial=true,
-- expires_at = now + free_trial_days. They keep Free's normal feature set and
-- the standard 3-tests/day cap during the window.
--
-- When expires_at passes, the student does NOT silently degrade — they hit
-- a hard upgrade gate. /api/auth/me detects the expired-Free-trial state
-- and returns is_free_expired=true, which the student layout intercepts and
-- redirects every /student/* route (except /student/expired itself) to a
-- lockout page that prompts them to upgrade to Premium. This is the explicit
-- difference vs paid-plan expiry, which gracefully drops to Free.
--
-- Why a single int column rather than a full plans-style table:
--   - There's exactly one validity window platform-wide. Per-cohort or
--     per-marketing-campaign trials are a v2 concern.
--   - Default 7 days. Setting to 0 makes Free permanent (no expiry, no gate).
--   - Capped 0-90 to prevent accidental indefinite-grant configs and to
--     prevent typos producing absurd validity windows.
--
-- The is_trial flag on subscriptions distinguishes auto-granted Free rows
-- from any future manually-created Free rows (e.g. school-side overrides).
-- The expiry-gate only fires when tier='free' AND is_trial=true AND past
-- expires_at — paid Premium users are never affected by this mechanism.
-- =============================================================================

-- Add the configurable trial duration to the singleton subscription_limits row.
alter table public.subscription_limits
  add column if not exists free_trial_days integer not null default 7
    check (free_trial_days >= 0 and free_trial_days <= 90);

comment on column public.subscription_limits.free_trial_days is
  'How many days the Free plan stays valid for a new independent student before they hit the upgrade gate. Default 7 days. Set to 0 to make Free permanent (no expiry). Capped at 90 to prevent accidental indefinite-grant configs. Editable from the platform admin page at /admin/plans.';

-- Add is_trial flag to subscriptions so the dashboard can distinguish a paid
-- Premium from a trial Premium without inferring from auto_renew or amount_paid.
alter table public.subscriptions
  add column if not exists is_trial boolean not null default false;

comment on column public.subscriptions.is_trial is
  'True when this subscription row was auto-granted by the Free-plan-validity mechanism (subscription_limits.free_trial_days > 0). When tier=free + is_trial=true + past expires_at, the student is hard-gated to /student/expired until they upgrade — they do NOT silently drop to permanent Free.';

-- Set the existing singleton row's value to 7 so installations that already
-- ran migration 10 (which inserted the row with whatever the column default
-- was at THAT time) don't end up with an unset/null value. Idempotent: only
-- updates when free_trial_days is currently null or 0 to avoid stomping on a
-- value the platform admin has already configured.
update public.subscription_limits
   set free_trial_days = 7
 where id = 1
   and (free_trial_days is null or free_trial_days = 0);

-- Notify schema reload.
notify pgrst, 'reload schema';
