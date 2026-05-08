-- =============================================================================
-- 56_co_teacher_rls_consolidated.sql
-- -----------------------------------------------------------------------------
-- Single-transaction consolidation of the three co-teacher RLS fixes.
-- Replaces 53, 54, 55. Run this AND ONLY THIS — it's idempotent on prior
-- runs of those migrations, and it ends with a `select` that prints the
-- policies that were actually applied so you can verify.
--
-- The three permissive SELECT policies it installs:
--
--   1. "attempts class co-teacher read"  on quiz_attempts
--   2. "ans class co-teacher read"       on attempt_answers
--   3. "assign class co-teacher read"    on quiz_assignments
--   4. "quizzes class co-teacher read"   on quizzes
--
-- All four use public.is_class_teacher (defined in migration 04, SECURITY
-- DEFINER, no RLS recursion).
-- =============================================================================

begin;

-- 1) attempts
drop policy if exists "attempts class co-teacher read" on public.quiz_attempts;
create policy "attempts class co-teacher read" on public.quiz_attempts
  for select using (
    exists (
      select 1
      from public.quiz_assignments qa
      where qa.quiz_id = quiz_attempts.quiz_id
        and qa.class_id is not null
        and public.is_class_teacher(qa.class_id)
    )
  );

-- 2) answers
drop policy if exists "ans class co-teacher read" on public.attempt_answers;
create policy "ans class co-teacher read" on public.attempt_answers
  for select using (
    exists (
      select 1
      from public.quiz_attempts a
      join public.quiz_assignments qa on qa.quiz_id = a.quiz_id
      where a.id = attempt_id
        and qa.class_id is not null
        and public.is_class_teacher(qa.class_id)
    )
  );

-- 3) assignments
drop policy if exists "assign class co-teacher read" on public.quiz_assignments;
create policy "assign class co-teacher read" on public.quiz_assignments
  for select using (
    class_id is not null and public.is_class_teacher(class_id)
  );

-- 4) quizzes
drop policy if exists "quizzes class co-teacher read" on public.quizzes;
create policy "quizzes class co-teacher read" on public.quizzes
  for select using (
    exists (
      select 1
      from public.quiz_assignments qa
      where qa.quiz_id = quizzes.id
        and qa.class_id is not null
        and public.is_class_teacher(qa.class_id)
    )
  );

commit;

notify pgrst, 'reload schema';

-- ===== Verification — paste the WHOLE thing including this select. =====
-- This must return EXACTLY 4 rows (one per policy above). If it returns
-- fewer, one of the create-policy statements failed silently and we
-- need to re-run. If you see all 4 rows, RLS is correctly applied.
select tablename, policyname
from pg_policies
where policyname in (
  'attempts class co-teacher read',
  'ans class co-teacher read',
  'assign class co-teacher read',
  'quizzes class co-teacher read'
)
order by tablename, policyname;
