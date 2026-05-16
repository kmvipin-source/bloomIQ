-- supabase/migrations/98_profiles_last_teaching_context.sql
-- =============================================================================
-- Per-teacher sticky default for the "Teaching context" dropdown added to
-- /teacher/generate (and later /teacher/quizzes/new). Stores the category
-- slug the teacher last picked (matches lib/questionCategory.ts vocabulary:
-- class5_8, class_9, class_10_boards, class_12_boards, jee_main, jee_advanced,
-- bitsat, gate, neet, cat, gmat, gre, upsc, nda, bank_exams, clat, ielts, sat,
-- cuet, corporate, other).
--
-- Why a separate column vs. reusing profiles.learner_profile or exam_goal:
--   - learner_profile = teacher's OWN learning identity (what THEY'd study).
--   - exam_goal       = teacher's OWN exam target.
--   - last_teaching_context = who they're TEACHING. A single teacher running
--     Class 6 mornings + JEE coaching evenings legitimately switches between
--     contexts per generation. Conflating with the above two breaks that.
--
-- Nullable, no default. The picker UI falls back to classGradeToCategory()
-- when this is null. RLS unchanged.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_teaching_context text;

-- Constraint is intentionally PERMISSIVE — only rejects free-text garbage.
-- Slug list intentionally mirrors lib/questionCategory.ts categoryLabel cases.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_last_teaching_context_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_last_teaching_context_check
  CHECK (
    last_teaching_context IS NULL OR last_teaching_context IN (
      'class5_8', 'class_9', 'class_10_boards', 'class_12_boards',
      'jee_main', 'jee_advanced', 'bitsat', 'gate',
      'neet',
      'cat', 'gmat', 'gre',
      'upsc', 'nda', 'bank_exams',
      'clat', 'ielts', 'sat', 'cuet',
      'corporate', 'other'
    )
  );

COMMENT ON COLUMN public.profiles.last_teaching_context IS
  'Last teaching-context slug picked on /teacher/generate or /teacher/quizzes/new. Vocabulary matches lib/questionCategory.ts. Null = unset. Used to seed the picker on next visit.';
