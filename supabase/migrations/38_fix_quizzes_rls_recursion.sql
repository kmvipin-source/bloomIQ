-- =============================================================================
-- Migration 38 — fix infinite-recursion in quizzes / quiz_assignments policies
-- -----------------------------------------------------------------------------
-- Migration 35 added:
--
--   policy "quizzes read for assigned" on public.quizzes
--     for select using ( exists (select 1 from public.quiz_assignments qa
--                                where qa.quiz_id = quizzes.id ...) );
--
-- Migration 31 had already added:
--
--   policy "assign select" on public.quiz_assignments
--     for select using ( exists (select 1 from public.quizzes q
--                                where q.id = quiz_assignments.quiz_id
--                                  and q.owner_id = auth.uid()) ... );
--
-- These reference each other. When Postgres evaluates either policy, the
-- inner SELECT triggers the other table's RLS, which loops back. Result:
--
--   ERROR: infinite recursion detected in policy for relation "quizzes"
--
-- This breaks any flow that touches quizzes via RLS — including
-- /student/adaptive-practice ("Could not save questions: infinite recursion ...").
--
-- Fix: encapsulate the cross-table membership check in a SECURITY DEFINER
-- helper, which executes with the function owner's privileges and so
-- bypasses RLS on the inner SELECT. Same pattern as is_class_teacher /
-- is_class_primary / is_super_for_school, established in migration 04.
-- =============================================================================

-- Helper: am I (auth.uid()) assigned to quiz qid, directly or via a class
-- I'm a member of? SECURITY DEFINER → the inner SELECT runs without RLS,
-- breaking the cycle.
create or replace function public.is_quiz_assigned_to_me(qid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.quiz_assignments qa
    where qa.quiz_id = qid
      and (
        qa.student_id = auth.uid()
        or (
          qa.class_id is not null
          and exists (
            select 1 from public.class_members m
            where m.class_id = qa.class_id and m.student_id = auth.uid()
          )
        )
      )
  );
$$;

-- Replace the recursive policy with one that uses the helper.
drop policy if exists "quizzes read for assigned" on public.quizzes;
create policy "quizzes read for assigned" on public.quizzes
  for select using ( public.is_quiz_assigned_to_me(id) );

-- PostgREST schema cache reload so the API sees the new function.
notify pgrst, 'reload schema';
