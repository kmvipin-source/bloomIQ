-- BloomIQ: Independent-student exam goal.
-- Captured via a single-question onboarding card on /student the first time
-- an independent student lands on the dashboard. Drives tile prioritisation:
-- a JEE aspirant sees Sprint + Trap Detector + Rank Predictor up top, while
-- a Class 10 board student sees Teach-Back + Misconception + Memory.
--
-- We store the value as free-form text but the UI restricts it to the eight
-- known goals (see /student/page.tsx ONBOARDING_GOALS). New goals can be
-- added later without a migration.
--
-- Additive. Run after migration 23.

alter table public.profiles
  add column if not exists exam_goal text,
  add column if not exists exam_goal_set_at timestamptz;

-- Cheap secondary index — most queries will filter to a specific goal
-- (e.g. cohort-wise mock rank predictor) so a btree on a low-cardinality
-- column is still worth having.
create index if not exists profiles_exam_goal_idx
  on public.profiles (exam_goal)
  where exam_goal is not null;

-- Reload PostgREST schema so the new columns are visible to the API.
notify pgrst, 'reload schema';
