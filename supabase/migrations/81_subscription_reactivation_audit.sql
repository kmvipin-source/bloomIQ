-- =============================================================================
-- 81_subscription_reactivation_audit.sql
-- -----------------------------------------------------------------------------
-- Phase G audit-trail extension. Suspend already logs WHO + WHEN + WHY
-- (migration 75). Reactivate clears those columns but doesn't preserve who
-- unblocked the school — finance ops asked for symmetric auditability so
-- they can answer "who reactivated Alpha School on 2026-04-12?" without
-- digging through application logs.
--
-- We add:
--   subscriptions.reactivated_at  → timestamp of most-recent reactivation
--   subscriptions.reactivated_by  → auth.uid() of the admin who did it
--
-- Both are nullable and last-write-wins. For full historical replay you
-- still need to add a subscription_event_log table; that's a separate
-- migration. This change is the minimal "one cell upgrade" parity with
-- payment_recorded_at / payment_recorded_by.
--
-- Re-running safe via IF NOT EXISTS guards.
-- =============================================================================

alter table public.subscriptions
  add column if not exists reactivated_at  timestamptz,
  add column if not exists reactivated_by  uuid references auth.users(id) on delete set null;

comment on column public.subscriptions.reactivated_at is
  'Server timestamp of the most-recent /reactivate (or mark-paid that flipped status active). Migration 81.';

comment on column public.subscriptions.reactivated_by is
  'auth.uid() of the platform admin who reactivated this subscription. Migration 81.';

create index if not exists subscriptions_reactivated_idx
  on public.subscriptions (reactivated_at desc)
  where reactivated_at is not null;

notify pgrst, 'reload schema';
