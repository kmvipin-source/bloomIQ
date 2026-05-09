-- =============================================================================
-- 63_subscription_contracted_students.sql
-- -----------------------------------------------------------------------------
-- A school's subscription value is two distinct things:
--
--   (a) ACTUAL active students   — count of profiles with role='student'
--                                  and school_id=this. Grows over the
--                                  year as the school onboards kids.
--   (b) CONTRACTED students      — the number the school agreed to in
--                                  the contract. The price was set on
--                                  THIS number, not (a). Examples:
--                                  "Plan covers up to 700 students,
--                                  ₹35,000 flat for the year."
--
-- Until now we only stored (a) (implicitly via profile rows). The price
-- formula did `per_student × actual`, which is correct for self-serve
-- but wrong for B2B negotiated deals where the school paid for 700
-- seats but only 23 have signed in by Day 30.
--
-- This migration adds `contracted_students`. The admin UI surfaces it,
-- the invoice uses it as the line-item quantity, and the price-without-
-- override calculation switches to contracted_students × rate.
-- =============================================================================

alter table public.subscriptions
  add column if not exists contracted_students integer
  check (contracted_students is null or contracted_students > 0);

comment on column public.subscriptions.contracted_students is
  'Negotiated number of student seats for this contract period. Drives invoice line-item quantity and the calculated list price. NULL = "use actual current student count" (sensible default for self-serve flows).';

notify pgrst, 'reload schema';
