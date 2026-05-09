-- =============================================================================
-- 62_subscription_negotiated_price.sql
-- -----------------------------------------------------------------------------
-- Make negotiated B2B school deals first-class. Until now `subscriptions`
-- only stored which plan a school was on; the actual price was always
-- computed at runtime as plans.per_student_price_paise × actual student
-- count. That works for self-serve flows but breaks the moment a school
-- negotiates a rounded number (e.g. ₹35,000 flat for 700 students even
-- though list price would be ₹48,300).
--
-- This migration adds:
--
--   override_price_paise    integer,  nullable. If set, this is THE
--                                     subscription price — the plans
--                                     × students formula is ignored.
--   override_reason         text,     audit context: "Multi-year deal,
--                                     closed by Vipin May 2026".
--   override_set_by         uuid,     who entered the override.
--   override_set_at         timestamptz when.
--
--   invoice_number          text      human-readable invoice ref the
--                                     finance team uses to reconcile.
--   payment_method          text      'razorpay' (online), 'neft' /
--                                     'cheque' (manual), 'manual' for
--                                     anything else. Lets finance
--                                     filter Razorpay vs direct.
--   payment_received_at     timestamptz  set by the platform admin
--                                     when NEFT lands. NULL until paid.
-- =============================================================================

alter table public.subscriptions
  add column if not exists override_price_paise integer,
  add column if not exists override_reason      text,
  add column if not exists override_set_by      uuid references auth.users(id),
  add column if not exists override_set_at      timestamptz,
  add column if not exists invoice_number       text,
  add column if not exists payment_method       text,
  add column if not exists payment_received_at  timestamptz;

-- Soft enum on payment_method. Drop+create so it's idempotent.
alter table public.subscriptions
  drop constraint if exists subscriptions_payment_method_check;
alter table public.subscriptions
  add constraint subscriptions_payment_method_check
  check (payment_method is null or payment_method in ('razorpay', 'neft', 'cheque', 'manual'));

-- Quick lookup by invoice number for finance reconciliation.
create unique index if not exists subscriptions_invoice_number_idx
  on public.subscriptions (invoice_number) where invoice_number is not null;

-- Index for pulling outstanding invoices in the admin UI ("show me
-- subscriptions where an invoice exists but payment hasn't landed").
create index if not exists subscriptions_unpaid_invoice_idx
  on public.subscriptions (payment_received_at) where invoice_number is not null and payment_received_at is null;

notify pgrst, 'reload schema';
