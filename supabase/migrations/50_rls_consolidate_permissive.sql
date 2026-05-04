-- =============================================================================
-- 50_rls_consolidate_permissive.sql
-- =============================================================================
-- Supabase advisor: multiple_permissive_policies WARN on 8 tables. Postgres
-- OR-joins permissive policies anyway, so semantics don't change — but each
-- policy is evaluated separately per row, so consolidating shaves planner +
-- exec cost. Strategy:
--   * Keep one SELECT policy per table with all original USING predicates OR'd.
--   * For ALL policies that overlap SELECT, split into per-cmd
--     (INSERT/UPDATE/DELETE) so the SELECT path is single-policy.
-- Behavior is identical: every prior allow path is preserved.
-- =============================================================================

-- ---------- live_sessions ----------
drop policy if exists "live_sessions host all" on public.live_sessions;
drop policy if exists "live_sessions players read" on public.live_sessions;

create policy "live_sessions select" on public.live_sessions
  for select
  using (
    host_teacher_id = (select auth.uid())
    or status = any (array['lobby','running','ended'])
  );
create policy "live_sessions host insert" on public.live_sessions
  for insert with check (host_teacher_id = (select auth.uid()));
create policy "live_sessions host update" on public.live_sessions
  for update using (host_teacher_id = (select auth.uid()))
            with check (host_teacher_id = (select auth.uid()));
create policy "live_sessions host delete" on public.live_sessions
  for delete using (host_teacher_id = (select auth.uid()));

-- ---------- plan_change_proposals ----------
-- proposals_admin_write (ALL) already covers SELECT with the same predicate
-- as proposals_admin_read. Drop the redundant SELECT-only policy.
drop policy if exists proposals_admin_read on public.plan_change_proposals;

-- ---------- profiles ----------
drop policy if exists "profiles read by platform admin" on public.profiles;
drop policy if exists "profiles read by super" on public.profiles;
drop policy if exists "profiles read same school" on public.profiles;
drop policy if exists "profiles read self" on public.profiles;

create policy "profiles select" on public.profiles
  for select
  using (
    is_platform_admin()
    or is_super_for_user(id)
    or (school_id is not null and school_id = current_user_school_id())
    or id = (select auth.uid())
  );

-- ---------- question_bank ----------
drop policy if exists "qb owner all" on public.question_bank;
drop policy if exists "qb read approved via quiz" on public.question_bank;
drop policy if exists "qb read for own attempt" on public.question_bank;
drop policy if exists "qb read for own srs" on public.question_bank;

create policy "qb select" on public.question_bank
  for select
  using (
    owner_id = (select auth.uid())
    or (status = 'approved' and exists (
      select 1 from public.quiz_questions qq where qq.question_id = question_bank.id
    ))
    or exists (
      select 1 from public.attempt_answers a
      join public.quiz_attempts qa on qa.id = a.attempt_id
      where a.question_id = question_bank.id and qa.student_id = (select auth.uid())
    )
    or exists (
      select 1 from public.srs_reviews r
      where r.question_id = question_bank.id and r.user_id = (select auth.uid())
    )
  );
create policy "qb owner insert" on public.question_bank
  for insert with check (owner_id = (select auth.uid()));
create policy "qb owner update" on public.question_bank
  for update using (owner_id = (select auth.uid()))
            with check (owner_id = (select auth.uid()));
create policy "qb owner delete" on public.question_bank
  for delete using (owner_id = (select auth.uid()));

-- ---------- quiz_assignments ----------
drop policy if exists "assign select" on public.quiz_assignments;
drop policy if exists "assign student read" on public.quiz_assignments;

create policy "assign select" on public.quiz_assignments
  for select
  using (
    exists (
      select 1 from public.quizzes q
      where q.id = quiz_assignments.quiz_id and q.owner_id = (select auth.uid())
    )
    or (class_id is not null and is_class_primary(class_id))
    or (class_id is not null and exists (
      select 1 from public.classes c
      where c.id = quiz_assignments.class_id and is_super_for_school(c.school_id)
    ))
    or (student_id is not null and is_super_for_user(student_id))
    or student_id = (select auth.uid())
    or exists (
      select 1 from public.class_members m
      where m.class_id = quiz_assignments.class_id and m.student_id = (select auth.uid())
    )
  );

-- ---------- quiz_questions ----------
-- "qq read by quiz reader" predicate (exists quizzes q where q.id=quiz_id) is
-- a strict superset of owner-based read. Keep that for SELECT; split owner ALL
-- into write-only per-cmd policies.
drop policy if exists "qq write owner" on public.quiz_questions;

create policy "qq owner insert" on public.quiz_questions
  for insert with check (
    exists (select 1 from public.quizzes q
            where q.id = quiz_questions.quiz_id and q.owner_id = (select auth.uid()))
  );
create policy "qq owner update" on public.quiz_questions
  for update using (
    exists (select 1 from public.quizzes q
            where q.id = quiz_questions.quiz_id and q.owner_id = (select auth.uid()))
  ) with check (
    exists (select 1 from public.quizzes q
            where q.id = quiz_questions.quiz_id and q.owner_id = (select auth.uid()))
  );
create policy "qq owner delete" on public.quiz_questions
  for delete using (
    exists (select 1 from public.quizzes q
            where q.id = quiz_questions.quiz_id and q.owner_id = (select auth.uid()))
  );

-- ---------- quiz_retake_requests ----------
drop policy if exists "qrr student read own" on public.quiz_retake_requests;
drop policy if exists "qrr teacher read assigned" on public.quiz_retake_requests;

create policy "qrr select" on public.quiz_retake_requests
  for select
  using (
    student_id = (select auth.uid())
    or teacher_id = (select auth.uid())
  );

-- ---------- quizzes ----------
drop policy if exists "quizzes owner all" on public.quizzes;
drop policy if exists "quizzes read for assigned" on public.quizzes;
drop policy if exists "quizzes super read" on public.quizzes;

create policy "quizzes select" on public.quizzes
  for select
  using (
    owner_id = (select auth.uid())
    or is_quiz_assigned_to_me(id)
    or is_super_for_user(owner_id)
  );
create policy "quizzes owner insert" on public.quizzes
  for insert with check (owner_id = (select auth.uid()));
create policy "quizzes owner update" on public.quizzes
  for update using (owner_id = (select auth.uid()))
            with check (owner_id = (select auth.uid()));
create policy "quizzes owner delete" on public.quizzes
  for delete using (owner_id = (select auth.uid()));

notify pgrst, 'reload schema';
