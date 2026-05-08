-- =============================================================================
-- 58_visibility_primary_or_assigner.sql
-- -----------------------------------------------------------------------------
-- Tightens the co-teacher visibility rule introduced in 53–57.
--
-- OLD RULE (overly permissive, set in 57 via is_quiz_in_my_class):
--   A quiz is visible to me if it's assigned to ANY class I teach
--   (primary or co). Means a co-teacher sees every test the primary
--   teacher pushes to their class — which is too much when you've got
--   subject co-teachers who shouldn't see assessments outside their lane.
--
-- NEW RULE (per product owner):
--   A quiz is visible to me if EITHER
--     (a) I am PRIMARY on a class it is assigned to (full visibility on
--         the class — primary owns it), OR
--     (b) I personally assigned it (i.e. quiz_assignments.assigned_by =
--         auth.uid()) — covers the "I pushed this test even though I'm
--         only co on the class" case.
--
--   Quiz OWNER is still always visible — handled by the separate
--   "owner all" policies (existing in migration 01), not touched here.
--
-- This migration:
--   1. Replaces helper public.is_quiz_in_my_class with a new
--      SECURITY DEFINER helper public.is_quiz_visible_to_me(qid).
--   2. Re-points the three policies that used the old helper to use
--      the new one, with the updated rule.
--   3. Tightens the quiz_assignments "co-teacher read" policy to the
--      same rule (was: "primary or co"; now: "primary or assigner").
--
-- Idempotent on a clean run of 57.
-- =============================================================================

begin;

-- ----- New helper -----------------------------------------------------------
-- SECURITY DEFINER so the inner SELECTs bypass RLS (avoids the
-- quizzes ↔ quiz_assignments recursion that bit us in 57).
create or replace function public.is_quiz_visible_to_me(qid uuid)
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
        -- (a) I am primary on a class this quiz is assigned to
        (
          qa.class_id is not null
          and exists (
            select 1
            from public.class_teachers ct
            where ct.class_id   = qa.class_id
              and ct.teacher_id = auth.uid()
              and ct.role       = 'primary'
          )
        )
        -- (b) I personally created this assignment row
        or qa.assigned_by = auth.uid()
      )
  );
$$;

-- ----- quizzes --------------------------------------------------------------
drop policy if exists "quizzes class co-teacher read" on public.quizzes;
create policy "quizzes class co-teacher read" on public.quizzes
  for select using (public.is_quiz_visible_to_me(id));

-- ----- quiz_attempts --------------------------------------------------------
drop policy if exists "attempts class co-teacher read" on public.quiz_attempts;
create policy "attempts class co-teacher read" on public.quiz_attempts
  for select using (public.is_quiz_visible_to_me(quiz_id));

-- ----- attempt_answers ------------------------------------------------------
drop policy if exists "ans class co-teacher read" on public.attempt_answers;
create policy "ans class co-teacher read" on public.attempt_answers
  for select using (
    exists (
      select 1
      from public.quiz_attempts a
      where a.id = attempt_id
        and public.is_quiz_visible_to_me(a.quiz_id)
    )
  );

-- ----- quiz_assignments -----------------------------------------------------
-- Old rule: any class teacher (primary or co) of the target class.
-- New rule: primary of the target class, OR I am the assigner of this row.
-- (Quiz owner case is handled by the existing "assign owner all" policy
--  from migration 01, untouched here.)
drop policy if exists "assign class co-teacher read" on public.quiz_assignments;
create policy "assign class co-teacher read" on public.quiz_assignments
  for select using (
    (class_id is not null and public.is_class_primary(class_id))
    or assigned_by = auth.uid()
  );

-- ----- Drop the old helper if nothing references it -------------------------
-- We renamed the helper to make the new rule clear at the call site. The
-- old helper is no longer used by any policy. Drop it so it doesn't drift.
drop function if exists public.is_quiz_in_my_class(uuid);

commit;

notify pgrst, 'reload schema';

-- ===== Verification — paste the WHOLE thing including these selects. =====
-- Should return 4 policy rows, the new helper definition, and (no longer)
-- the old helper.
select tablename, policyname
from pg_policies
where policyname in (
  'attempts class co-teacher read',
  'ans class co-teacher read',
  'assign class co-teacher read',
  'quizzes class co-teacher read'
)
order by tablename, policyname;

select proname
from pg_proc
where proname in ('is_quiz_visible_to_me', 'is_quiz_in_my_class')
order by proname;
