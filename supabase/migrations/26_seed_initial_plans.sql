-- BloomIQ: Seed the initial plan catalogue.
--
-- Inserts five active plans matching the current /pricing copy plus two
-- new Premium Plus tiers that have no subscribers yet. After this runs,
-- /admin/plans will show:
--
--   slug                       tier            status   price (paise)
--   ---------------------------------------------------------------
--   free                       free            active        0
--   premium_monthly            premium         active     9900   (₹99)
--   premium_annual             premium         active    99900   (₹999)
--   premium_plus_monthly       premium_plus    active    19900   (₹199 placeholder)
--   premium_plus_annual        premium_plus    active   199900   (₹1999 placeholder)
--
-- Premium Plus prices are placeholders — the platform admin should adjust
-- them via /admin/plans/[id]/edit before going live. Editing creates a
-- NEW plan version; existing subscribers stay grandfathered onto the old
-- one (which is the whole point of the versioning system).
--
-- Idempotent: each insert uses ON CONFLICT DO NOTHING on the (slug,status)
-- partial-unique index, so re-running this migration is safe.
--
-- Additive. Run after migration 25.

-- ========================================================================
-- 1) Insert the five initial plans
-- ========================================================================
insert into public.plans
  (slug, tier, label, blurb, feature_summary, price_paise, currency, period_days, features, status, effective_from)
values

  ('free', 'free', 'Free', 'Try BloomIQ. No card needed.',
   array[
     '3 practice tests per day',
     'Basic Bloom report',
     'Single device only'
   ]::text[],
   0, 'INR', 0,
   '[
     "single_device"
   ]'::jsonb,
   'active', now()),

  ('premium_monthly', 'premium', 'Premium Monthly', 'Per month. Cancel anytime.',
   array[
     'Unlimited practice tests',
     'Full Bloom-level mastery report',
     'Past-Paper X-Ray',
     'Doubt-Clearing AI Tutor',
     'Speed-Accuracy Trainer',
     'Distractor Trap Detector',
     'Mock Rank Predictor',
     'Misconception Detective',
     'Memory Tune-Up'
   ]::text[],
   9900, 'INR', 30,
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
     "knowledge_graph"
   ]'::jsonb,
   'active', now()),

  ('premium_annual', 'premium', 'Premium Annual', 'Per year. Save vs monthly.',
   array[
     'Everything in Premium Monthly',
     'Priority access to new features',
     'Yearly progress recap PDF',
     'Best deal for one-shot exam prep'
   ]::text[],
   99900, 'INR', 365,
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
     "knowledge_graph"
   ]'::jsonb,
   'active', now()),

  ('premium_plus_monthly', 'premium_plus', 'Premium Plus Monthly',
   'Premium + cutting-edge AI tools.',
   array[
     'Everything in Premium',
     'Voice AI Teacher',
     'Concept Visualizer',
     'Priority email support'
   ]::text[],
   19900, 'INR', 30,
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
     "priority_support"
   ]'::jsonb,
   'active', now()),

  ('premium_plus_annual', 'premium_plus', 'Premium Plus Annual',
   'Premium Plus, billed yearly.',
   array[
     'Everything in Premium Plus Monthly',
     'Priority access to new features',
     'Yearly progress recap PDF'
   ]::text[],
   199900, 'INR', 365,
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
     "priority_support"
   ]'::jsonb,
   'active', now())

on conflict do nothing;

-- ========================================================================
-- 2) Backfill subscriptions.plan_id from the legacy tier text column.
-- ========================================================================
-- Best-effort mapping from the legacy `tier` values into the new plan
-- versions. We only set plan_id where it's currently null, so re-runs
-- are idempotent and don't clobber explicit assignments.
--
-- Mapping (legacy tier  ->  new slug):
--   free               -> free
--   individual         -> premium_monthly  (the old "Individual Monthly" was
--                         really the same product as new "Premium Monthly")
--   premium            -> premium_annual   (legacy 'premium' was the annual
--                         single-tier billing)
do $$
declare
  v_free uuid; v_pm uuid; v_pa uuid;
begin
  select id into v_free from public.plans where slug = 'free' and status = 'active' limit 1;
  select id into v_pm   from public.plans where slug = 'premium_monthly' and status = 'active' limit 1;
  select id into v_pa   from public.plans where slug = 'premium_annual' and status = 'active' limit 1;

  if v_free is not null then
    update public.subscriptions set plan_id = v_free
     where plan_id is null and tier = 'free';
  end if;
  if v_pm is not null then
    update public.subscriptions set plan_id = v_pm
     where plan_id is null and tier = 'individual';
  end if;
  if v_pa is not null then
    update public.subscriptions set plan_id = v_pa
     where plan_id is null and tier = 'premium';
  end if;
end $$;

notify pgrst, 'reload schema';
