-- =============================================================================
-- 74_b2b_billing_audit_and_gst.sql
-- -----------------------------------------------------------------------------
-- Schema additions for the B2B billing audit (Session 4):
--
--   D3  → subscriptions.payment_recorded_by, .payment_recorded_at
--   D10 → plans.grace_period_days  (per-plan grace default; sub still wins)
--   D11 → subscriptions.po_number  (school's purchase-order reference)
--   D12 → schools.state, schools.gstin  (Indian GST place-of-supply)
--   D15 → subscriptions.contract_years (multi-year deal tracking)
--   D18 → subscriptions.override_reason_type (enum-flavored reason category)
--
-- All ALTERs use IF NOT EXISTS / IF NOT EXISTS-style guards so re-running
-- the migration on partially-applied environments is safe. Run order from
-- migration 73 onward.
-- =============================================================================

-- ─── D3: audit trail on mark-paid ────────────────────────────────────────────
alter table public.subscriptions
  add column if not exists payment_recorded_by uuid references auth.users(id) on delete set null,
  add column if not exists payment_recorded_at timestamptz;

comment on column public.subscriptions.payment_recorded_by is
  'auth.uid() of the platform admin who clicked "Mark payment received". Distinct from payment_received_at which is the customer-stated payment date. Migration 74.';

comment on column public.subscriptions.payment_recorded_at is
  'Server timestamp of when payment was marked received in BloomIQ. payment_received_at may be backdated to when the bank transfer actually arrived; this column is non-mutable history. Migration 74.';

create index if not exists subscriptions_payment_recorded_by_idx
  on public.subscriptions (payment_recorded_by)
  where payment_recorded_by is not null;

-- ─── D10: per-plan grace period default ──────────────────────────────────────
alter table public.plans
  add column if not exists grace_period_days integer not null default 14
    check (grace_period_days >= 0 and grace_period_days <= 90);

comment on column public.plans.grace_period_days is
  'Default grace-period window (days) for this plan. The actual subscription row can still override this via its own grace_period_days. Migration 74.';

-- ─── D11: PO number on subscriptions ─────────────────────────────────────────
alter table public.subscriptions
  add column if not exists po_number text;

comment on column public.subscriptions.po_number is
  'School-issued Purchase Order number for this subscription cycle. Free text — accepts whatever format the school provides (PO/2026/12345 etc). Used for finance reconciliation when the bank-transfer memo references the PO instead of the invoice. Migration 74.';

-- ─── D12: GST place-of-supply on schools ─────────────────────────────────────
-- Adding both state + gstin enables the invoice PDF generator to compute
-- CGST+SGST (9%+9%) when the school is in the same state as the vendor,
-- or IGST (18%) when they differ. Both nullable for now — the invoice
-- generator falls back to IGST if state is missing.
alter table public.schools
  add column if not exists state text,
  add column if not exists gstin text;

comment on column public.schools.state is
  'School''s registered state, e.g. "Maharashtra" or "Karnataka". Drives GST place-of-supply for invoice generation. Migration 74.';

comment on column public.schools.gstin is
  'School''s GSTIN (15-char alphanumeric). Required on the invoice PDF if the school is a registered business. Migration 74.';

-- Light validation: a non-empty gstin should be the standard 15-char format.
-- We accept NULL or empty (schools without GST registration), but if
-- present, enforce the shape. Using a check constraint instead of a
-- domain so we don't introduce a new type just for this.
alter table public.schools
  add constraint schools_gstin_format_check
  check (
    gstin is null
    or gstin = ''
    or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  );

-- ─── D15: multi-year contract tracking ───────────────────────────────────────
alter table public.subscriptions
  add column if not exists contract_years integer
    check (contract_years is null or (contract_years >= 1 and contract_years <= 10));

comment on column public.subscriptions.contract_years is
  'If set, indicates this is a multi-year deal — used by the auto-renewal logic to NOT auto-renew at the end of one period_days cycle but instead extend until contract_years anniversary. Null = standard single-cycle subscription. Migration 74.';

-- ─── D18: enum-flavored override_reason_type ─────────────────────────────────
-- We keep the legacy free-text override_reason for the human-readable
-- explanation, but add a structured `override_reason_type` column the
-- admin UI can dropdown-pick to make finance reporting consistent.
alter table public.subscriptions
  add column if not exists override_reason_type text
    check (
      override_reason_type is null
      or override_reason_type in (
        'multi_year_deal',
        'volume_discount',
        'partner_discount',
        'pilot_program',
        'goodwill',
        'corrective',
        'other'
      )
    );

comment on column public.subscriptions.override_reason_type is
  'Structured category for override_reason. Free text reason stays in override_reason. Lets finance group deals consistently across schools. Migration 74.';

-- ─── Reload PostgREST schema ─────────────────────────────────────────────────
notify pgrst, 'reload schema';
