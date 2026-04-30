-- BloomIQ: Per-student pricing on plans.
--
-- Adds an alternate pricing model for school plans: instead of a flat
-- price_paise per period, the school pays a per-student rate × the
-- number of seats. Independent plans (Free / Premium / Premium Plus)
-- continue to use pricing_model='fixed', which is the default and
-- preserves all existing behaviour.
--
-- Why per-student:
--   - It's the dominant model for Indian K-12 EdTech school SaaS
--     (Embibe, Toppr, BYJU's-school all bill this way).
--   - Scales naturally with school size — no awkward jumps between
--     fixed brackets.
--   - Makes the pitch ("₹X per student per year") concrete on /pricing.
--
-- Teachers stay uncapped — there is no per-teacher charge and no cap
-- in code on how many teachers an Admin Head can invite. This matches
-- Vipin's spec: "no limit required on teachers."
--
-- Additive. Run after migration 26.

alter table public.plans
  add column if not exists pricing_model text not null default 'fixed'
    check (pricing_model in ('fixed', 'per_student')),
  add column if not exists per_student_price_paise integer not null default 0
    check (per_student_price_paise >= 0),
  add column if not exists min_students integer not null default 0
    check (min_students >= 0),
  add column if not exists max_students integer
    check (max_students is null or max_students > 0);

-- A per-student plan must specify a positive per-student price.
-- Idempotent guard so re-running this migration is safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'plans_per_student_price_required'
      and conrelid = 'public.plans'::regclass
  ) then
    alter table public.plans
      add constraint plans_per_student_price_required
      check (
        pricing_model <> 'per_student'
        or per_student_price_paise > 0
      );
  end if;
end $$;

-- Existing rows are explicitly tagged as 'fixed' (default already does
-- this; we set it again for clarity in case anyone manually altered
-- previous test data).
update public.plans
  set pricing_model = 'fixed'
  where pricing_model is null;

notify pgrst, 'reload schema';
