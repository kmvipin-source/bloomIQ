-- =============================================================================
-- 60_school_plan_cleanup.sql
-- -----------------------------------------------------------------------------
-- Tighten the school-plan seed so the customer-facing feature_summary
-- and the enforced features[] array agree, and so the AI-driven
-- features (digest, Coach) live behind a real gate instead of
-- being implicitly free for every tier.
--
-- Three changes:
--
-- 1. Remove `weekly_digest` from school_pilot's features[] array.
--    The seed had it on every tier, but This Week is an LLM-driven
--    digest — the same cost-controlled bucket as Coach. Standard
--    and Plus keep it; Pilot becomes a basic-tier plan that no
--    longer includes the AI digest.
--
-- 2. Add Coach quota strings to feature_summary so the pricing
--    page (which renders feature_summary literally) shows the
--    quota numbers the customer actually gets:
--      - Pilot:    "Coach not included (upgrade to Standard)"
--      - Standard: "Principal Coach: 50 questions per user / month"
--      - Plus:     "Principal Coach: unlimited"
--
-- 3. Add `weekly_digest` line to Standard's feature_summary (it was
--    in features[] but missing from the human-readable list, so the
--    pricing page didn't show it as a Standard benefit).
--
-- Idempotent: re-runnable safely. Updates by slug.
-- =============================================================================

-- ── (1) Remove weekly_digest from Pilot's enforced feature list ──
update public.plans
set features = (features - 'weekly_digest')
where slug = 'school_pilot';

-- ── (2 + 3) Refresh feature_summary on all three school plans ──
update public.plans
set feature_summary = array[
  'Up to 100 students',
  'Unlimited teachers',
  'All student practice tools (no voice tutor / visualizer)',
  'Admin Head dashboard',
  'Bloom Pulse (view only — exports require Standard)',
  'Coach not included (upgrade to Standard for 50 questions / user / month)',
  'Email support'
]::text[]
where slug = 'school_pilot';

update public.plans
set feature_summary = array[
  'Up to 500 students',
  'Unlimited teachers',
  'Everything in School Pilot',
  'Bloom Pulse PDF + Excel export',
  'Principal & Teacher Coach: 50 questions per user / month',
  'This Week — auto-generated weekly briefing',
  'Priority email support'
]::text[]
where slug = 'school_standard';

update public.plans
set feature_summary = array[
  '500+ students (no upper limit)',
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

-- ── Verification — paste with the migration ──
select slug, label,
       (features ? 'weekly_digest')   as has_weekly_digest_key,
       (features ? 'bloom_pulse')     as has_bloom_pulse_key,
       (features ? 'principal_coach') as has_principal_coach_key
from public.plans
where slug like 'school_%'
order by tier;
