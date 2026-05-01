-- =============================================================================
-- Migration 35 — close the 'quizzes read by code' + 'qq read auth' RLS holes
-- -----------------------------------------------------------------------------
-- Two of the four HIGH-severity RLS_AUDIT findings:
--   - public.quizzes.'quizzes read by code'  → for select to authenticated using (true)
--   - public.quiz_questions.'qq read auth'   → for select to authenticated using (true)
--
-- Anyone signed in could list every teacher's quizzes (and via the join,
-- every quiz-question linkage) across schools. Drop both policies and
-- replace with assignment-scoped reads.
--
-- Required code prerequisite: /student/join and /student/quiz/[code] now go
-- through GET /api/student/quiz-by-code which uses the service-role admin
-- client behind the auth check, so the join-by-code flow keeps working.
-- /api/student/quick-test and /api/student/adaptive-practice also switched
-- their code-collision check to the admin client so cross-user collisions
-- are still detectable.
-- =============================================================================

drop policy if exists "quizzes read by code" on public.quizzes;
drop policy if exists "qq read auth"          on public.quiz_questions;

-- Students can SELECT a quiz they're assigned to — directly, or via class.
drop policy if exists "quizzes read for assigned" on public.quizzes;
create policy "quizzes read for assigned" on public.quizzes
  for select using (
    exists (
      select 1 from public.quiz_assignments qa
      where qa.quiz_id = quizzes.id
        and (
          qa.student_id = (select auth.uid())
          or (qa.class_id is not null and exists (
            select 1 from public.class_members m
            where m.class_id = qa.class_id and m.student_id = (select auth.uid())
          ))
        )
    )
  );

-- Quiz-questions inherit visibility from the parent quiz: if you can see
-- the quiz row, you can see its questions. The EXISTS subquery on quizzes
-- triggers RLS on quizzes itself, so an anonymous probe still sees nothing.
drop policy if exists "qq read by quiz reader" on public.quiz_questions;
create policy "qq read by quiz reader" on public.quiz_questions
  for select using (
    exists (select 1 from public.quizzes q where q.id = quiz_questions.quiz_id)
  );

notify pgrst, 'reload schema';

-- Still open (deferred):
--   - public.question_bank.'qb read approved' — many server routes depend
--     on it, requires switching ~20 routes to admin client. Backlog.
--   - public.schools.'schools read by code' / public.classes.'classes read by code'
--     — required by the join-school / join-class flows. Replace with
--     dedicated admin-mediated endpoints. Backlog.
