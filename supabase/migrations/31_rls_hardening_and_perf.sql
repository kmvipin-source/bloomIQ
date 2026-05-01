-- =============================================================================
-- Migration 30 — RLS hardening + perf cleanup
-- -----------------------------------------------------------------------------
-- Multi-part migration applied via Supabase MCP. Captured here so teammates
-- can replay on a fresh database. All blocks are idempotent (drop policy if
-- exists / create index if not exists / etc.).
--
-- 1. Fills `plan_audit` table that migration 25 ships in some envs but was
--    missing on the live DB.
-- 2. Revokes EXECUTE on three SECURITY DEFINER trigger fns from anon /
--    authenticated (advisor: anon_security_definer_function_executable).
-- 3. Adds 10 covering indexes on foreign keys (advisor:
--    unindexed_foreign_keys).
-- 4. Rewrites every RLS policy that called `auth.<fn>()` per-row to use
--    `(select auth.<fn>())` so Postgres init-plans the call once per query
--    (advisor: auth_rls_initplan).
-- 5. Tightens `profiles read all auth` (which gave every authenticated user
--    cross-school read access) to a same-school policy. Cross-school reads
--    now blocked. Self / super_teacher / platform_admin reads preserved.
-- 6. Consolidates `multiple_permissive_policies` per (table, role, action)
--    into single OR'd policies. Splits ALL policies into per-cmd where
--    they overlap with role-specific SELECT policies. No functional change
--    to access — just fewer policies for the planner to evaluate per row.
--
-- NOT INCLUDED (deferred):
--   - 4 HIGH RLS findings on `quizzes` / `quiz_questions` / `question_bank`
--     read-all-auth: code-based join flow at `/student/join` and
--     `/student/quiz/[code]` reads these tables directly with bearer token,
--     so tightening the SELECT policies needs a server-side intermediary
--     (e.g. `POST /api/student/join-by-code`) first.
--   - `schools.read by code` / `classes.read by code`: same pattern.
--   - Dropping unused indexes: stat period too short on a recently reset DB.
--
-- =============================================================================

-- =============================================================================
-- 1. plan_audit table (was missing from migration 25 on live DB)
-- =============================================================================
create table if not exists public.plan_audit (
  id bigserial primary key,
  plan_id uuid not null references public.plans(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists plan_audit_plan_idx on public.plan_audit (plan_id, created_at desc);
create index if not exists plan_audit_actor_idx on public.plan_audit (actor_id);

alter table public.plan_audit enable row level security;

drop policy if exists "plan_audit read by platform admin" on public.plan_audit;
create policy "plan_audit read by platform admin" on public.plan_audit
  for select using (public.is_platform_admin());

drop policy if exists "plan_audit insert by platform admin" on public.plan_audit;
create policy "plan_audit insert by platform admin" on public.plan_audit
  for insert with check (public.is_platform_admin());

-- =============================================================================
-- 2. Lock down trigger fns (never called as RPC — only by triggers)
-- =============================================================================
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_new_class() from public, anon, authenticated;
revoke execute on function public.check_attempt_quota() from public, anon, authenticated;

-- =============================================================================
-- 3. Covering indexes on unindexed foreign keys
-- =============================================================================
create index if not exists alerts_quiz_id_idx                    on public.alerts (quiz_id);
create index if not exists attempt_answers_question_id_idx       on public.attempt_answers (question_id);
create index if not exists class_teacher_invites_invited_by_idx  on public.class_teacher_invites (invited_by);
create index if not exists live_session_answers_question_id_idx  on public.live_session_answers (question_id);
create index if not exists live_session_answers_student_id_idx   on public.live_session_answers (student_id);
create index if not exists live_session_players_student_id_idx   on public.live_session_players (student_id);
create index if not exists live_sessions_quiz_id_idx             on public.live_sessions (quiz_id);
create index if not exists quiz_assignments_assigned_by_idx      on public.quiz_assignments (assigned_by);
create index if not exists quiz_questions_question_id_idx        on public.quiz_questions (question_id);
create index if not exists student_password_resets_reset_by_idx  on public.student_password_resets (reset_by);

-- =============================================================================
-- 4. Init-plan rewrite: auth.<fn>() -> (select auth.<fn>())
-- -----------------------------------------------------------------------------
-- Programmatic rewrite of every public-schema RLS policy that calls
-- auth.uid()/role()/jwt() directly. Postgres canonicalises the new form
-- to `( SELECT auth.uid() AS uid)` once stored.
-- =============================================================================
do $$
declare
  r record;
  new_q text;
  new_wc text;
  ddl text;
begin
  for r in
    select schemaname, tablename, policyname, permissive, cmd, roles, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and ((qual ~ 'auth\.\w+\(\)' and qual !~ '\(select auth\.\w+\(\)\)')
           or (with_check ~ 'auth\.\w+\(\)' and with_check !~ '\(select auth\.\w+\(\)\)'))
  loop
    new_q  := regexp_replace(r.qual,       'auth\.(\w+)\(\)', '(select auth.\1())', 'g');
    new_wc := regexp_replace(r.with_check, 'auth\.(\w+)\(\)', '(select auth.\1())', 'g');

    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);

    ddl := format(
      'create policy %I on %I.%I as %s for %s to %s',
      r.policyname, r.schemaname, r.tablename,
      r.permissive, r.cmd, array_to_string(r.roles, ',')
    );
    if new_q  is not null then ddl := ddl || ' using ('     || new_q  || ')'; end if;
    if new_wc is not null then ddl := ddl || ' with check (' || new_wc || ')'; end if;

    execute ddl;
  end loop;
end $$;

-- =============================================================================
-- 5. profiles: tighten cross-school read
-- -----------------------------------------------------------------------------
-- Before: `profiles read all auth` granted SELECT to every authenticated user
-- regardless of school. Closes a HIGH-severity RLS audit finding.
-- After: split into 4 permissive SELECT policies — Postgres ORs them. Same-
-- school clause looks up the caller's school_id via a SECURITY DEFINER helper
-- (`current_user_school_id()`) so the inner read bypasses RLS. Without this,
-- the inner SELECT is itself subject to the same-school policy → infinite
-- recursion → profile fetch fails → student layout bounces back to /login.
-- =============================================================================
create or replace function public.current_user_school_id()
returns uuid
language sql stable security definer set search_path = 'public'
as $$
  select school_id from public.profiles where id = auth.uid();
$$;

revoke execute on function public.current_user_school_id() from public;
grant execute on function public.current_user_school_id() to authenticated;
-- anon also gets EXECUTE — RLS evaluates ALL policies on every query (incl.
-- the same-school clause that calls this fn), so anon callers must be able
-- to execute it. Function safely returns NULL when auth.uid() is NULL, so
-- anon never sees any school_id match.
grant execute on function public.current_user_school_id() to anon;

drop policy if exists "profiles read all auth"        on public.profiles;
drop policy if exists "profiles read by platform admin" on public.profiles;
drop policy if exists "profiles read same school"      on public.profiles;
drop policy if exists "profiles read self"             on public.profiles;
drop policy if exists "profiles super read"            on public.profiles;
drop policy if exists "profiles select"                on public.profiles;
drop policy if exists "profiles read by super"         on public.profiles;

create policy "profiles read self" on public.profiles
  for select using ((select auth.uid()) = id);

create policy "profiles read by super" on public.profiles
  for select using (public.is_super_for_user(id));

create policy "profiles read by platform admin" on public.profiles
  for select using (public.is_platform_admin());

create policy "profiles read same school" on public.profiles
  for select using (
    school_id is not null
    and school_id = public.current_user_school_id()
  );

-- =============================================================================
-- 6. multiple_permissive_policies — consolidate per (table, role, action)
-- -----------------------------------------------------------------------------
-- Each block: drop overlapping policies, recreate with OR'd qual / with_check.
-- =============================================================================

-- 6a. Drop redundant SELECT-only policies whose qual matches the matching
-- ALL-cmd policy on the same table. Coverage is preserved by the ALL policy.
drop policy if exists "bcs own select"   on public.bloom_climber_state;
drop policy if exists "bcstr own select" on public.bloom_climber_streaks;
drop policy if exists "ca own select"    on public.concept_animations;
drop policy if exists "cc own select"    on public.confidence_calibrations;
drop policy if exists "dda own select"   on public.daily_drill_attempts;
drop policy if exists "dt own select"    on public.distractor_traps;
drop policy if exists "ess own select"   on public.exam_sprint_settings;
drop policy if exists "kg own select"    on public.knowledge_graphs;
drop policy if exists "mrp own select"   on public.mock_rank_predictions;
drop policy if exists "pi own select"    on public.parent_invites;
drop policy if exists "xrq own select"   on public.past_paper_xray_questions;
drop policy if exists "xr own select"    on public.past_paper_xrays;
drop policy if exists "ss own select"    on public.speed_sessions;
drop policy if exists "srs own select"   on public.srs_reviews;

-- 6b. alerts: 'teacher read' qual was identical to 'teacher write' (ALL); drop
drop policy if exists "alerts teacher read" on public.alerts;

-- 6c. student_logins: merge primary + self
drop policy if exists "logins read by primary" on public.student_logins;
drop policy if exists "logins read self"        on public.student_logins;
create policy "logins select" on public.student_logins
  for select using (
    public.is_primary_for_student(user_id)
    or (select auth.uid()) = user_id
  );

-- 6d. subscriptions: merge school members + self
drop policy if exists "subs read school members" on public.subscriptions;
drop policy if exists "subs read self"            on public.subscriptions;
create policy "subs select" on public.subscriptions
  for select using (
    (select auth.uid()) = user_id
    or (
      school_id is not null
      and exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid()) and p.school_id = subscriptions.school_id
      )
    )
  );

-- 6e. attempt_answers: split student-own ALL into per-cmd; merge SELECT
drop policy if exists "ans primary read"    on public.attempt_answers;
drop policy if exists "ans quiz owner read" on public.attempt_answers;
drop policy if exists "ans student own"     on public.attempt_answers;

create policy "ans select" on public.attempt_answers
  for select using (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_answers.attempt_id and a.student_id = (select auth.uid()))
    or exists (select 1 from public.quiz_attempts a
               where a.id = attempt_answers.attempt_id and public.is_primary_for_student(a.student_id))
    or exists (select 1 from public.quiz_attempts a
               join public.quizzes q on q.id = a.quiz_id
               where a.id = attempt_answers.attempt_id and q.owner_id = (select auth.uid()))
  );
create policy "ans student insert" on public.attempt_answers
  for insert with check (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_answers.attempt_id and a.student_id = (select auth.uid()))
  );
create policy "ans student update" on public.attempt_answers
  for update using (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_answers.attempt_id and a.student_id = (select auth.uid()))
  ) with check (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_answers.attempt_id and a.student_id = (select auth.uid()))
  );
create policy "ans student delete" on public.attempt_answers
  for delete using (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_answers.attempt_id and a.student_id = (select auth.uid()))
  );

-- 6f. exam_attempts
drop policy if exists "exam_attempts owner read"   on public.exam_attempts;
drop policy if exists "exam_attempts owner update" on public.exam_attempts;
drop policy if exists "exam_attempts student own"  on public.exam_attempts;

create policy "exam_attempts select" on public.exam_attempts
  for select using (
    (select auth.uid()) = student_id
    or exists (select 1 from public.exam_papers p
               where p.id = exam_attempts.paper_id and p.owner_id = (select auth.uid()))
  );
create policy "exam_attempts student insert" on public.exam_attempts
  for insert with check ((select auth.uid()) = student_id);
create policy "exam_attempts update" on public.exam_attempts
  for update using (
    (select auth.uid()) = student_id
    or exists (select 1 from public.exam_papers p
               where p.id = exam_attempts.paper_id and p.owner_id = (select auth.uid()))
  ) with check (
    (select auth.uid()) = student_id
    or exists (select 1 from public.exam_papers p
               where p.id = exam_attempts.paper_id and p.owner_id = (select auth.uid()))
  );
create policy "exam_attempts student delete" on public.exam_attempts
  for delete using ((select auth.uid()) = student_id);

-- 6g. exam_attempt_answers
drop policy if exists "exam_answers owner read"   on public.exam_attempt_answers;
drop policy if exists "exam_answers owner update" on public.exam_attempt_answers;
drop policy if exists "exam_answers student own"  on public.exam_attempt_answers;

create policy "exam_answers select" on public.exam_attempt_answers
  for select using (
    exists (select 1 from public.exam_attempts a
            where a.id = exam_attempt_answers.attempt_id and a.student_id = (select auth.uid()))
    or exists (select 1 from public.exam_attempts a
               join public.exam_papers p on p.id = a.paper_id
               where a.id = exam_attempt_answers.attempt_id and p.owner_id = (select auth.uid()))
  );
create policy "exam_answers student insert" on public.exam_attempt_answers
  for insert with check (
    exists (select 1 from public.exam_attempts a
            where a.id = exam_attempt_answers.attempt_id and a.student_id = (select auth.uid()))
  );
create policy "exam_answers update" on public.exam_attempt_answers
  for update using (
    exists (select 1 from public.exam_attempts a
            where a.id = exam_attempt_answers.attempt_id and a.student_id = (select auth.uid()))
    or exists (select 1 from public.exam_attempts a
               join public.exam_papers p on p.id = a.paper_id
               where a.id = exam_attempt_answers.attempt_id and p.owner_id = (select auth.uid()))
  ) with check (
    exists (select 1 from public.exam_attempts a
            where a.id = exam_attempt_answers.attempt_id and a.student_id = (select auth.uid()))
    or exists (select 1 from public.exam_attempts a
               join public.exam_papers p on p.id = a.paper_id
               where a.id = exam_attempt_answers.attempt_id and p.owner_id = (select auth.uid()))
  );
create policy "exam_answers student delete" on public.exam_attempt_answers
  for delete using (
    exists (select 1 from public.exam_attempts a
            where a.id = exam_attempt_answers.attempt_id and a.student_id = (select auth.uid()))
  );

-- 6h. live_session_answers
drop policy if exists "lsa host read" on public.live_session_answers;
drop policy if exists "lsa self"      on public.live_session_answers;

create policy "lsa select" on public.live_session_answers
  for select using (
    student_id = (select auth.uid())
    or exists (select 1 from public.live_sessions s
               where s.id = live_session_answers.session_id and s.host_teacher_id = (select auth.uid()))
  );
create policy "lsa self insert" on public.live_session_answers
  for insert with check (student_id = (select auth.uid()));
create policy "lsa self update" on public.live_session_answers
  for update using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()));
create policy "lsa self delete" on public.live_session_answers
  for delete using (student_id = (select auth.uid()));

-- 6i. live_session_players
drop policy if exists "lsp host read" on public.live_session_players;
drop policy if exists "lsp self"      on public.live_session_players;

create policy "lsp select" on public.live_session_players
  for select using (
    student_id = (select auth.uid())
    or exists (select 1 from public.live_sessions s
               where s.id = live_session_players.session_id and s.host_teacher_id = (select auth.uid()))
  );
create policy "lsp self insert" on public.live_session_players
  for insert with check (student_id = (select auth.uid()));
create policy "lsp self update" on public.live_session_players
  for update using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()));
create policy "lsp self delete" on public.live_session_players
  for delete using (student_id = (select auth.uid()));

-- 6j. plans: keep public read; split ALL into per-cmd writes
drop policy if exists "plans read by platform admin"  on public.plans;
drop policy if exists "plans read public"             on public.plans;
drop policy if exists "plans write by platform admin" on public.plans;

create policy "plans read public" on public.plans
  for select using (true);
create policy "plans insert by platform admin" on public.plans
  for insert with check (public.is_platform_admin());
create policy "plans update by platform admin" on public.plans
  for update using (public.is_platform_admin())
  with check (public.is_platform_admin());
create policy "plans delete by platform admin" on public.plans
  for delete using (public.is_platform_admin());

-- 6k. class_members
drop policy if exists "members primary manage" on public.class_members;
drop policy if exists "members self"           on public.class_members;
drop policy if exists "members super read"     on public.class_members;
drop policy if exists "members teacher read"   on public.class_members;

create policy "members select" on public.class_members
  for select using (
    public.is_class_primary(class_id)
    or public.is_class_teacher(class_id)
    or (select auth.uid()) = student_id
    or exists (select 1 from public.classes c where c.id = class_members.class_id and public.is_super_for_school(c.school_id))
  );
create policy "members insert" on public.class_members
  for insert with check (
    public.is_class_primary(class_id)
    or (select auth.uid()) = student_id
  );
create policy "members update" on public.class_members
  for update using (
    public.is_class_primary(class_id)
    or (select auth.uid()) = student_id
  ) with check (
    public.is_class_primary(class_id)
    or (select auth.uid()) = student_id
  );
create policy "members delete" on public.class_members
  for delete using (
    public.is_class_primary(class_id)
    or (select auth.uid()) = student_id
  );

-- 6l. class_teacher_invites
drop policy if exists "cti class teacher read" on public.class_teacher_invites;
drop policy if exists "cti primary manage"     on public.class_teacher_invites;
drop policy if exists "cti super manage"       on public.class_teacher_invites;

create policy "cti select" on public.class_teacher_invites
  for select using (
    public.is_class_teacher(class_id)
    or public.is_class_primary(class_id)
    or exists (select 1 from public.classes c where c.id = class_teacher_invites.class_id and public.is_super_for_school(c.school_id))
  );
create policy "cti insert" on public.class_teacher_invites
  for insert with check (
    public.is_class_primary(class_id)
    or exists (select 1 from public.classes c where c.id = class_teacher_invites.class_id and public.is_super_for_school(c.school_id))
  );
create policy "cti update" on public.class_teacher_invites
  for update using (
    public.is_class_primary(class_id)
    or exists (select 1 from public.classes c where c.id = class_teacher_invites.class_id and public.is_super_for_school(c.school_id))
  ) with check (
    public.is_class_primary(class_id)
    or exists (select 1 from public.classes c where c.id = class_teacher_invites.class_id and public.is_super_for_school(c.school_id))
  );
create policy "cti delete" on public.class_teacher_invites
  for delete using (
    public.is_class_primary(class_id)
    or exists (select 1 from public.classes c where c.id = class_teacher_invites.class_id and public.is_super_for_school(c.school_id))
  );

-- 6m. class_teachers
drop policy if exists "ct primary manage"        on public.class_teachers;
drop policy if exists "ct read by class teacher" on public.class_teachers;
drop policy if exists "ct read self"             on public.class_teachers;
drop policy if exists "ct super manage"          on public.class_teachers;
drop policy if exists "ct super read"            on public.class_teachers;

create policy "ct select" on public.class_teachers
  for select using (
    public.is_class_primary(class_id)
    or public.is_class_teacher(class_id)
    or (select auth.uid()) = teacher_id
    or public.is_super_for_user(teacher_id)
  );
create policy "ct insert" on public.class_teachers
  for insert with check (
    public.is_class_primary(class_id)
    or public.is_super_for_user(teacher_id)
  );
create policy "ct update" on public.class_teachers
  for update using (
    public.is_class_primary(class_id)
    or public.is_super_for_user(teacher_id)
  ) with check (
    public.is_class_primary(class_id)
    or public.is_super_for_user(teacher_id)
  );
create policy "ct delete" on public.class_teachers
  for delete using (
    public.is_class_primary(class_id)
    or public.is_super_for_user(teacher_id)
  );

-- 6n. classes (role=public dups; 'classes read by code' for authenticated kept)
drop policy if exists "classes primary delete" on public.classes;
drop policy if exists "classes primary modify" on public.classes;
drop policy if exists "classes super delete"   on public.classes;
drop policy if exists "classes super modify"   on public.classes;
drop policy if exists "classes super read"     on public.classes;
drop policy if exists "classes teacher read"   on public.classes;

create policy "classes select" on public.classes
  for select using (
    public.is_super_for_school(school_id)
    or public.is_class_teacher(id)
  );
create policy "classes update" on public.classes
  for update using (
    public.is_class_primary(id)
    or public.is_super_for_school(school_id)
  ) with check (
    public.is_class_primary(id)
    or public.is_super_for_school(school_id)
  );
create policy "classes delete" on public.classes
  for delete using (
    public.is_class_primary(id)
    or public.is_super_for_school(school_id)
  );

-- 6o. quiz_assignments (role=public dups; 'assign student read' for authenticated kept)
drop policy if exists "assign owner all"    on public.quiz_assignments;
drop policy if exists "assign primary read" on public.quiz_assignments;
drop policy if exists "assign super read"   on public.quiz_assignments;

create policy "assign select" on public.quiz_assignments
  for select using (
    exists (select 1 from public.quizzes q where q.id = quiz_assignments.quiz_id and q.owner_id = (select auth.uid()))
    or ((class_id is not null) and public.is_class_primary(class_id))
    or ((class_id is not null) and exists (select 1 from public.classes c where c.id = quiz_assignments.class_id and public.is_super_for_school(c.school_id)))
    or ((student_id is not null) and public.is_super_for_user(student_id))
  );
create policy "assign insert" on public.quiz_assignments
  for insert with check (
    exists (select 1 from public.quizzes q where q.id = quiz_assignments.quiz_id and q.owner_id = (select auth.uid()))
    and (((class_id is not null) and public.is_class_teacher(class_id)) or ((student_id is not null) and public.is_teacher_for_student(student_id)))
  );
create policy "assign update" on public.quiz_assignments
  for update using (
    exists (select 1 from public.quizzes q where q.id = quiz_assignments.quiz_id and q.owner_id = (select auth.uid()))
  ) with check (
    exists (select 1 from public.quizzes q where q.id = quiz_assignments.quiz_id and q.owner_id = (select auth.uid()))
    and (((class_id is not null) and public.is_class_teacher(class_id)) or ((student_id is not null) and public.is_teacher_for_student(student_id)))
  );
create policy "assign delete" on public.quiz_assignments
  for delete using (
    exists (select 1 from public.quizzes q where q.id = quiz_assignments.quiz_id and q.owner_id = (select auth.uid()))
  );

-- 6p. quiz_attempts
drop policy if exists "attempts primary read"    on public.quiz_attempts;
drop policy if exists "attempts quiz owner read" on public.quiz_attempts;
drop policy if exists "attempts student own"     on public.quiz_attempts;
drop policy if exists "attempts super read"      on public.quiz_attempts;

create policy "attempts select" on public.quiz_attempts
  for select using (
    (select auth.uid()) = student_id
    or public.is_primary_for_student(student_id)
    or exists (select 1 from public.quizzes q where q.id = quiz_attempts.quiz_id and q.owner_id = (select auth.uid()))
    or public.is_super_for_user(student_id)
    or exists (select 1 from public.quizzes q where q.id = quiz_attempts.quiz_id and public.is_super_for_user(q.owner_id))
  );
create policy "attempts student insert" on public.quiz_attempts
  for insert with check ((select auth.uid()) = student_id);
create policy "attempts student update" on public.quiz_attempts
  for update using ((select auth.uid()) = student_id)
  with check ((select auth.uid()) = student_id);
create policy "attempts student delete" on public.quiz_attempts
  for delete using ((select auth.uid()) = student_id);

-- 6q. schools (role=public dups; 'schools read by code' for authenticated kept)
drop policy if exists "schools insert by platform admin" on public.schools;
drop policy if exists "schools insert self"               on public.schools;
drop policy if exists "schools read by member"            on public.schools;
drop policy if exists "schools read by platform admin"    on public.schools;
drop policy if exists "schools update by platform admin"  on public.schools;
drop policy if exists "schools update by super"           on public.schools;

create policy "schools insert" on public.schools
  for insert with check (
    public.is_platform_admin()
    or super_teacher_id = (select auth.uid())
  );
create policy "schools select" on public.schools
  for select using (
    public.is_platform_admin()
    or super_teacher_id = (select auth.uid())
    or id in (select school_id from public.profiles where id = (select auth.uid()))
  );
create policy "schools update" on public.schools
  for update using (
    public.is_platform_admin()
    or super_teacher_id = (select auth.uid())
  ) with check (
    public.is_platform_admin()
    or super_teacher_id = (select auth.uid())
  );

-- =============================================================================
-- Reload PostgREST so the API picks up new tables / policies.
-- =============================================================================
notify pgrst, 'reload schema';
