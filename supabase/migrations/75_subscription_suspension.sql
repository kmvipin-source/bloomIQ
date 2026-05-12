-- =============================================================================
-- 75_subscription_suspension.sql
-- -----------------------------------------------------------------------------
-- Schema additions for the "suspend school for non-payment, preserve all data"
-- workflow (Session 5 follow-up):
--
--   subscriptions.suspended_at      → server timestamp when admin clicked Suspend
--   subscriptions.suspended_by      → auth.uid() of the admin who did it
--   subscriptions.suspended_reason  → free-text note for the audit trail
--
-- The `status` text column already exists and accepts arbitrary values; the
-- new convention is:
--   'active'    → school has full feature access
--   'past_due'  → invoiced but unpaid for > grace window (still active in DB)
--   'suspended' → admin manually deactivated; school locked out, data intact
--
-- Suspension is purely a feature-access toggle. Nothing is deleted, archived,
-- or hidden from the school — they just can't generate/take new tests, see
-- AI coach output, etc. Re-activate via mark-paid (auto) or the reactivate
-- endpoint (manual).
--
-- Re-running safe via IF NOT EXISTS guards. Run order from migration 74.
-- =============================================================================

alter table public.subscriptions
  add column if not exists suspended_at      timestamptz,
  add column if not exists suspended_by      uuid references auth.users(id) on delete set null,
  add column if not exists suspended_reason  text;

comment on column public.subscriptions.suspended_at is
  'Server timestamp when status flipped to ''suspended''. Null when not suspended. Migration 75.';

comment on column public.subscriptions.suspended_by is
  'auth.uid() of the platform admin who suspended this subscription. Migration 75.';

comment on column public.subscriptions.suspended_reason is
  'Free-text reason (e.g. "Non-payment after 30 days, BLM/2026/0007"). Surfaced in the per-school admin page. Migration 75.';

-- Index only the suspended rows — the vast majority of subscriptions won't
-- be suspended, and the platform admin dashboard wants a fast "show me all
-- past-due / suspended schools" query.
create index if not exists subscriptions_suspended_idx
  on public.subscriptions (suspended_at desc)
  where suspended_at is not null;

-- Reload PostgREST so the new columns become visible to the API layer
-- without a manual server restart.
notify pgrst, 'reload schema';
