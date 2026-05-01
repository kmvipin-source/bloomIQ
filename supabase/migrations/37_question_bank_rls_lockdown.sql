-- =============================================================================
-- Migration 37 — close 'qb read approved' (last HIGH RLS finding)
-- -----------------------------------------------------------------------------
-- 'qb read approved' was `for select to authenticated using (status = 'approved')`,
-- which let any signed-in user read every approved question stem across all
-- schools and owners.
--
-- Replace with three tighter, additive policies:
--   1. "qb read approved via quiz" — approved + reachable via quiz_questions
--      (the EXISTS subquery inherits quiz_questions' RLS, which inherits
--      quizzes' RLS, so a user only sees questions of quizzes they own /
--      are super for / are assigned to).
--   2. "qb read for own attempt" — user has an attempt_answers row that
--      references the question. Lets routes that mine past wrong answers
--      (misconception, traps, daily-drill yesterday-misses, etc.) keep
--      working through the user-token client.
--   3. "qb read for own srs" — user has an srs_reviews row referencing the
--      question. /api/srs/due joins via this.
--
-- Existing 'qb owner all' covers owners reading their own questions; super
-- and platform_admin keep their visibility through the broader profiles
-- channel and there is no super-specific policy on question_bank yet (not
-- needed because they read questions through quiz_questions).
--
-- Code prerequisite: /api/student/daily-drill switched its cross-owner
-- weak-level question pool read to the service-role admin client. Other
-- cross-owner reads either already use admin or are owner-scoped.
-- =============================================================================

drop policy if exists "qb read approved" on public.question_bank;

drop policy if exists "qb read approved via quiz" on public.question_bank;
create policy "qb read approved via quiz" on public.question_bank
  for select using (
    status = 'approved' and exists (
      select 1 from public.quiz_questions qq
      where qq.question_id = question_bank.id
    )
  );

drop policy if exists "qb read for own attempt" on public.question_bank;
create policy "qb read for own attempt" on public.question_bank
  for select using (
    exists (
      select 1 from public.attempt_answers a
      join public.quiz_attempts qa on qa.id = a.attempt_id
      where a.question_id = question_bank.id
        and qa.student_id = (select auth.uid())
    )
  );

drop policy if exists "qb read for own srs" on public.question_bank;
create policy "qb read for own srs" on public.question_bank
  for select using (
    exists (
      select 1 from public.srs_reviews r
      where r.question_id = question_bank.id
        and r.user_id = (select auth.uid())
    )
  );

notify pgrst, 'reload schema';
