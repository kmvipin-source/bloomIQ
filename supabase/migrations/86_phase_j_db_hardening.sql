-- =============================================================================
-- 86_phase_j_db_hardening.sql
-- -----------------------------------------------------------------------------
-- Phase J: a small batch of DB invariants + perf the audit flagged.
--
-- (a) CHECK constraint enforcing status='suspended' ↔ suspended_at NOT NULL.
--     Application code preserves this invariant on every write, but a
--     direct DB write (dashboard SQL, future trigger) could desync.
--     Validated as NOT VALID first so existing rows aren't blocked if
--     someone seeded test data that violates the rule — the application
--     code only writes consistent state going forward.
--
-- (b) Index invoice_number text_pattern_ops to speed up the year-prefix
--     ilike scan in mark-paid + invoice allocators. After a few hundred
--     archived rows the O(N) scan becomes the dominant cost of issuing
--     an invoice number.
--
-- (c) Tighten schools_gstin_format_check to reject empty strings going
--     forward (NULL stays valid). Legacy empty-string rows are
--     normalised to NULL so the new constraint doesn't break them.
-- =============================================================================

-- (a) suspended invariant
update public.subscriptions
   set suspended_at = coalesce(suspended_at, now())
 where status = 'suspended'
   and suspended_at is null;

alter table public.subscriptions
  drop constraint if exists subscriptions_suspended_consistent;
alter table public.subscriptions
  add constraint subscriptions_suspended_consistent
  check (
    (status = 'suspended' and suspended_at is not null)
    or (status <> 'suspended')
  ) not valid;
-- Validating separately so a single bad row blocks the migration with a
-- clear error rather than a generic syntax failure.
alter table public.subscriptions
  validate constraint subscriptions_suspended_consistent;

-- (b) text_pattern_ops index for the year-prefix scan.
create index if not exists subscriptions_invoice_number_pattern_idx
  on public.subscriptions (invoice_number text_pattern_ops)
  where invoice_number is not null;

create index if not exists subscription_invoice_archive_invoice_pattern_idx
  on public.subscription_invoice_archive (invoice_number text_pattern_ops)
  where invoice_number is not null;

-- (c) gstin: normalise legacy empties, then tighten constraint.
update public.schools set gstin = null where gstin = '';

alter table public.schools
  drop constraint if exists schools_gstin_format_check;
alter table public.schools
  add constraint schools_gstin_format_check
  check (
    gstin is null
    or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  );

notify pgrst, 'reload schema';
