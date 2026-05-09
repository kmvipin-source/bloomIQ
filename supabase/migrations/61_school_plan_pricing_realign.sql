-- =============================================================================
-- 61_school_plan_pricing_realign.sql
-- -----------------------------------------------------------------------------
-- Fix the pricing-curve inversion in the school-plan seed.
--
-- Before this migration:
--   School Pilot     ₹49 per student/year   (basic features)
--   School Standard  ₹39 per student/year   (more features)
--   School Plus      ₹29 per student/year   (most features)
--
-- The original intent was volume-bucket pricing (bigger school =
-- cheaper rate). We then layered feature differentiation on top
-- (Coach for Standard+, voice tutor + visualizer for Plus only),
-- which made the cheapest tier the most feature-rich. Customers
-- noticed.
--
-- After this migration:
--   School Pilot     ₹29 per student/year   (basic features, entry-level)
--   School Standard  ₹49 per student/year   (+ Coach, digest, exports)
--   School Plus      ₹69 per student/year   (+ voice tutor, visualizer, unlimited Coach, CSM)
--
-- Pricing now monotonically rises with feature richness — the
-- "better tier costs more" story customers expect. Volume rebate
-- (10–15% off above 500 students) becomes an invoice-time
-- discount applied by the platform admin, not a separate SKU.
--
-- Also drops min_students/max_students caps from Pilot and Standard
-- so a school self-selects on features, not size. Plus already had
-- no upper cap.
-- =============================================================================

update public.plans
set per_student_price_paise = 2900,                    -- ₹29
    min_students            = 20,
    max_students            = NULL,                     -- was 100; now uncapped
    blurb                   = 'Entry tier for any school. Annual. Per-student-per-year.',
    feature_summary         = array[
      'Any school size (20+ students)',
      'Unlimited teachers',
      'All student practice tools (no voice tutor / visualizer)',
      'Admin Head dashboard + Bloom Pulse (view only)',
      'Coach not included',
      'Email support'
    ]::text[]
where slug = 'school_pilot';

update public.plans
set per_student_price_paise = 4900,                    -- ₹49
    min_students            = 20,                       -- same floor; no upper cap
    max_students            = NULL,                     -- was 500; now uncapped
    blurb                   = 'For schools that want the AI helpers. Annual. Per-student-per-year.',
    feature_summary         = array[
      'Any school size (20+ students)',
      'Unlimited teachers',
      'Everything in School Pilot',
      'Bloom Pulse PDF + Excel export',
      'Principal & Teacher Coach: 50 questions per user / month',
      'This Week — auto-generated weekly briefing',
      'Priority email support'
    ]::text[]
where slug = 'school_standard';

update public.plans
set per_student_price_paise = 6900,                    -- ₹69
    min_students            = 20,                       -- was 500; volume bracket dropped
    max_students            = NULL,
    blurb                   = 'Premium tier with full AI suite + dedicated CSM. Annual.',
    feature_summary         = array[
      'Any school size (20+ students)',
      'Unlimited teachers',
      'Everything in School Standard',
      'Voice AI Teacher for every student',
      'Concept Visualizer for every student',
      'Principal & Teacher Coach: unlimited',
      'Cohort benchmarks',
      'Dedicated customer success manager'
    ]::text[]
where slug = 'school_plus';

notify pgrst, 'reload schema';

-- ── Verify — should show the new monotonic pricing ladder ──
select slug, label,
       per_student_price_paise / 100 as price_inr_per_student_per_year,
       min_students, max_students
from public.plans
where slug like 'school_%'
order by per_student_price_paise;
