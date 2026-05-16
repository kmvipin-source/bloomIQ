-- BloomIQ:
--   1) Class structured-naming fields (subject + section)
--   2) Schools + super_teacher role for cross-school admin
--   3) Class belongs to a school by definition; primary teacher is optional
-- Additive. Run after migrations 01-05.

-- ============ 1) Class naming standards ============
alter table public.classes
  add column if not exists subject text,
  add column if not exists section text;

-- ============ 2) Super-teacher role + schools ============
alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('teacher', 'student', 'super_teacher'));

-- F178b note (QA): when the schools.is_test_account column is added
-- per F178 (above), also wire the /admin/users-style "Beta tester" UI
-- toggle on /admin/schools/[id]. The users page already has the pattern
-- (search "is_test_account" in app/admin/users/page.tsx). Without UI
-- parity, ops will set the flag via raw SQL.
-- F178 note (QA): schools table has no is_test_account column. Today
-- the dashboard treats EVERY row as production for billing+admin counts.
-- For staging/load-test isolation, add a boolean is_test_account default
-- false and exclude in every aggregate query. Documentation-only today.
create table if not exists public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  super_teacher_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.schools enable row level security;

-- One admin head per school. The unique constraint allows multiple NULL rows
-- (a school can be temporarily headless if its admin head's account is
-- deleted), but no two schools can share the same active admin head. This
-- is the database-level guarantee behind the "one principal, one school"
-- rule — even direct DB edits cannot violate it.
alter table public.schools drop constraint if exists schools_one_per_admin;
alter table public.schools
  add constraint schools_one_per_admin unique (super_teacher_id);
-- F57 note (QA): models "one Admin Head per school" AND "one school
-- per Admin Head". Co-principals at private schools would need a
-- school_admin_heads junction table — deliberate v1 trade-off.

alter table public.profiles
  add column if not exists school_id uuid references public.schools(id) on delete set null;
create index if not exists profiles_school_idx on public.profiles (school_id);

-- ============ 3) classes belong to a school directly ============
-- A class is owned by a school, not by a teacher. The primary teacher
-- (classes.owner_id) is now optional and assigned later by the principal.
alter table public.classes
  add column if not exists school_id uuid references public.schools(id) on delete cascade;
alter table public.classes
  alter column owner_id drop not null;
create index if not exists classes_school_idx on public.classes (school_id);

-- Allow members of a school + the super_teacher to read it
drop policy if exists "schools read by member" on public.schools;
create policy "schools read by member" on public.schools
  for select using (
    super_teacher_id = auth.uid()
    or id in (select school_id from public.profiles where id = auth.uid())
  );

-- Super-teachers can update their own school
drop policy if exists "schools update by super" on public.schools;
create policy "schools update by super" on public.schools
  for update using (super_teacher_id = auth.uid())
  with check (super_teacher_id = auth.uid());

-- Anyone authenticated can create a school (they become its super_teacher)
drop policy if exists "schools insert self" on public.schools;
create policy "schools insert self" on public.schools
  for insert with check (super_teacher_id = auth.uid());

-- ============ Helpers ============
-- Am I the super_teacher for this user's school?
create or replace function public.is_super_for_user(other uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles me, public.profiles them
    where me.id = auth.uid()
      and me.role = 'super_teacher'
      and me.school_id is not null
      and them.id = other
      and them.school_id = me.school_id
  );
$$;

-- Am I the super_teacher for this school?
-- F64 note (QA): SECURITY DEFINER below. Callers can probe whether the
-- current auth.uid() is super_teacher of any given school_id regardless
-- of RLS. Low risk (school_id is not secret), but document the access.
create or replace function public.is_super_for_school(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles me
    where me.id = auth.uid()
      and me.role = 'super_teacher'
      and me.school_id = sid
  );
$$;

-- ============ Cross-school visibility for super_teachers ============

-- Profiles: super sees teachers + students in their school
drop policy if exists "profiles super read" on public.profiles;
create policy "profiles super read" on public.profiles
  for select using (public.is_super_for_user(id));

-- Classes: super sees every class in their school, including unassigned ones.
-- We key off school_id directly so a class with NULL owner_id is still visible.
drop policy if exists "classes super read" on public.classes;
create policy "classes super read" on public.classes
  for select using (public.is_super_for_school(school_id));

-- Class creation is principal-only. The class belongs to the principal's
-- school; a primary teacher (owner_id) is optional and can be assigned later.
drop policy if exists "classes super insert" on public.classes;
create policy "classes super insert" on public.classes
  for insert with check (public.is_super_for_school(school_id));

-- Principal can update / delete classes in their school. This is what powers
-- "assign primary teacher", "rename class", and "delete class" from the
-- school dashboard.
drop policy if exists "classes super modify" on public.classes;
create policy "classes super modify" on public.classes
  for update using (public.is_super_for_school(school_id))
  with check (public.is_super_for_school(school_id));

drop policy if exists "classes super delete" on public.classes;
create policy "classes super delete" on public.classes
  for delete using (public.is_super_for_school(school_id));

-- Principal can manage class_teachers rows for any class in their school.
drop policy if exists "ct super manage" on public.class_teachers;
create policy "ct super manage" on public.class_teachers
  for all using (public.is_super_for_user(teacher_id))
  with check (public.is_super_for_user(teacher_id));

-- Class teachers: super sees the teacher list for their school's classes
drop policy if exists "ct super read" on public.class_teachers;
create policy "ct super read" on public.class_teachers
  for select using (public.is_super_for_user(teacher_id));

-- Class members: super sees student rosters in their school's classes
drop policy if exists "members super read" on public.class_members;
create policy "members super read" on public.class_members
  for select using (
    exists (select 1 from public.classes c
            where c.id = class_id and public.is_super_for_school(c.school_id))
  );

-- Quizzes: super sees all quizzes by teachers in their school
drop policy if exists "quizzes super read" on public.quizzes;
create policy "quizzes super read" on public.quizzes
  for select using (public.is_super_for_user(owner_id));

-- Quiz attempts: super sees all attempts by students in their school OR on quizzes by teachers in their school
drop policy if exists "attempts super read" on public.quiz_attempts;
create policy "attempts super read" on public.quiz_attempts
  for select using (
    public.is_super_for_user(student_id)
    or exists (select 1 from public.quizzes q
               where q.id = quiz_id and public.is_super_for_user(q.owner_id))
  );

-- Quiz assignments: super sees all assignments for school's classes/students
drop policy if exists "assign super read" on public.quiz_assignments;
create policy "assign super read" on public.quiz_assignments
  for select using (
    (class_id is not null and exists (select 1 from public.classes c
                                      where c.id = class_id and public.is_super_for_school(c.school_id)))
    or (student_id is not null and public.is_super_for_user(student_id))
  );
