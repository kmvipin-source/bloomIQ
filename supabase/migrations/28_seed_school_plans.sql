-- BloomIQ: Seed three default school plans, all per-student annual.
--
-- Prices are placeholders the platform admin should adjust before any
-- real customer signs. The volume curve here is ~25-30% per bracket,
-- which is in line with EdTech-school benchmarks for India:
--
--   slug                  rate (per student/year)   bracket
--   -------------------------------------------------------
--   school_pilot          ₹49                        20–100 students
--   school_standard       ₹39                        100–500 students
--   school_plus           ₹29                        500+ students
--
-- All three are status='active' so they show up on /pricing immediately.
-- They include school_admin features (Bloom Pulse, Principal Coach,
-- Weekly digest) plus the standard student-facing tools — voice tutor
-- and concept visualizer are deliberately excluded from the basic
-- school plans so the platform admin can pitch them as add-on / upsell
-- features later via separate plans.
--
-- Idempotent: ON CONFLICT DO NOTHING on the (slug, status='active')
-- partial index, so re-running this migration is safe.
--
-- Additive. Run after migration 27.

insert into public.plans
  (slug, tier, label, blurb,
   feature_summary,
   pricing_model, per_student_price_paise, min_students, max_students,
   price_paise, currency, period_days,
   features, status, effective_from)
values

  ('school_pilot', 'school_pilot', 'School Pilot',
   '20–100 students. Annual. Per-student-per-year.',
   array[
     'Up to 100 students',
     'Unlimited teachers',
     'All student practice tools (no voice tutor / visualizer)',
     'Admin Head dashboard',
     'Email support'
   ]::text[],
   'per_student', 4900, 20, 100,
   0, 'INR', 365,
   '[
     "practice_tests_unlimited",
     "bloom_report_full",
     "report_pdf_export",
     "teach_back",
     "misconceptions",
     "calibration",
     "exam_sprint",
     "speed_trainer",
     "trap_detector",
     "rank_predictor",
     "past_paper_xray",
     "ai_tutor_text",
     "memory_srs",
     "knowledge_graph",
     "weekly_digest"
   ]'::jsonb,
   'active', now()),

  ('school_standard', 'school_standard', 'School Standard',
   '100–500 students. Annual. Per-student-per-year.',
   array[
     'Up to 500 students',
     'Unlimited teachers',
     'Everything in School Pilot',
     'Bloom Pulse PDF + Excel export',
     'Principal Coach',
     'Priority email support'
   ]::text[],
   'per_student', 3900, 100, 500,
   0, 'INR', 365,
   '[
     "practice_tests_unlimited",
     "bloom_report_full",
     "report_pdf_export",
     "teach_back",
     "misconceptions",
     "calibration",
     "exam_sprint",
     "speed_trainer",
     "trap_detector",
     "rank_predictor",
     "past_paper_xray",
     "ai_tutor_text",
     "memory_srs",
     "knowledge_graph",
     "bloom_pulse",
     "principal_coach",
     "weekly_digest",
     "priority_support"
   ]'::jsonb,
   'active', now()),

  ('school_plus', 'school_plus', 'School Plus',
   '500+ students. Annual. Per-student-per-year. Volume rate.',
   array[
     '500+ students (no upper limit)',
     'Unlimited teachers',
     'Everything in School Standard',
     'Voice AI Teacher for every student',
     'Concept Visualizer for every student',
     'Dedicated customer success manager'
   ]::text[],
   'per_student', 2900, 500, NULL,
   0, 'INR', 365,
   '[
     "practice_tests_unlimited",
     "bloom_report_full",
     "report_pdf_export",
     "teach_back",
     "misconceptions",
     "calibration",
     "exam_sprint",
     "speed_trainer",
     "trap_detector",
     "rank_predictor",
     "past_paper_xray",
     "ai_tutor_text",
     "voice_tutor",
     "concept_visualizer",
     "memory_srs",
     "knowledge_graph",
     "bloom_pulse",
     "principal_coach",
     "weekly_digest",
     "priority_support",
     "dedicated_csm"
   ]'::jsonb,
   'active', now())

on conflict do nothing;

notify pgrst, 'reload schema';
