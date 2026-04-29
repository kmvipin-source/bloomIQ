-- BloomIQ: Multi-teacher classes (primary + co-teachers)
-- Additive. Run after migrations 01, 02, 03.

-- ============ class_teachers ============
create table if not exists public.class_teachers (
  class_id uuid not null references public.classes(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'co' check (role in ('primary','co')),
  subject text,
  added_at timestamptz default now(),
  primary key (class_id, teacher_id)
);
create index if not exists ct_teacher_idx on public.class_teachers (teacher_id);
-- At most one primary per class
create unique index if not exists ct_one_primary_per_class
  on public.class_teachers (class_id) where role = 'primary';

alter table public.class_teachers enable row level security;

-- ============ Helper functions (security definer = bypass RLS, no recursion) ============
create or replace function public.is_class_teacher(cid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.class_teachers
    where class_id = cid and teacher_id = auth.uid()
  );
$$;

create or replace function public.is_class_primary(cid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.class_teachers
    where class_id = cid and teacher_id = auth.uid() and role = 'primary'
  );
$$;

-- For student-centric checks: am I a primary in any class the student belongs to?
create or replace function public.is_primary_for_student(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.class_members m
    join public.class_teachers ct on ct.class_id = m.class_id
    where m.student_id = sid
      and ct.teacher_id = auth.uid()
      and ct.role = 'primary'
  );
$$;

-- Am I any teacher (primary or co) for any class the student belongs to?
create or replace function public.is_teacher_for_student(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.class_members m
    join public.class_teachers ct on ct.class_id = m.class_id
    where m.student_id = sid
      and ct.teacher_id = auth.uid()
  );
$$;

-- ============ Backfill: every existing class.owner_id becomes a 'primary' row ============
insert into public.class_teachers (class_id, teacher_id, role)
select id, owner_id, 'primary'
from public.classes
where owner_id is not null
on conflict (class_id, teacher_id) do update set role = 'primary';

-- ============ Trigger: on class create, auto-add the owner as 'primary' ============
create or replace function public.handle_new_class()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A class can be created without a primary teacher (the principal assigns
  -- one later). Only seed the class_teachers row if owner_id is set.
  if new.owner_id is not null then
    insert into public.class_teachers (class_id, teacher_id, role)
    values (new.id, new.owner_id, 'primary')
    on conflict (class_id, teacher_id) do update set role = 'primary';
  end if;
  return new;
end;
$$;

drop trigger if exists on_class_created on public.classes;
create trigger on_class_created
  after insert on public.classes
  for each row execute function public.handle_new_class();

-- ============ class_teachers policies ============
drop policy if exists "ct read self" on public.class_teachers;
create policy "ct read self" on public.class_teachers
  for select using (auth.uid() = teacher_id);

-- Any teacher of the class can read the full teacher list (so co-teachers see who else is on it)
drop policy if exists "ct read by class teacher" on public.class_teachers;
create policy "ct read by class teacher" on public.class_teachers
  for select using (public.is_class_teacher(class_id));

-- Only the primary manages teacher rows (add/remove co-teachers, change subject)
drop policy if exists "ct primary manage" on public.class_teachers;
create policy "ct primary manage" on public.class_teachers
  for all using (public.is_class_primary(class_id))
  with check (public.is_class_primary(class_id));

-- ============ Rewire existing tables' RLS to use class_teachers ============

-- ----- classes -----
drop policy if exists "classes owner all" on public.classes;
drop policy if exists "classes read by code" on public.classes;

-- Any teacher of the class can SELECT it
drop policy if exists "classes teacher read" on public.classes;
create policy "classes teacher read" on public.classes
  for select using (public.is_class_teacher(id));

-- Authenticated users can look up by join code (needed for student join flow)
create policy "classes read by code" on public.classes
  for select to authenticated using (true);

-- Only primary can update / delete the class
drop policy if exists "classes primary modify" on public.classes;
create policy "classes primary modify" on public.classes
  for update using (public.is_class_primary(id)) with check (public.is_class_primary(id));

drop policy if exists "classes primary delete" on public.classes;
create policy "classes primary delete" on public.classes
  for delete using (public.is_class_primary(id));

-- Class creation is locked to principals (super_teacher). The actual insert
-- policy lives in migration 06 alongside the other school-level policies, so
-- we just make sure any older permissive "classes insert self" policy from a
-- previous schema version is removed.
drop policy if exists "classes insert self" on public.classes;

-- ----- class_members -----
drop policy if exists "members teacher" on public.class_members;
drop policy if exists "members teacher read" on public.class_members;

-- Any teacher of the class can SELECT members
create policy "members teacher read" on public.class_members
  for select using (public.is_class_teacher(class_id));

-- Only primary manages roster (add/remove students)
drop policy if exists "members primary manage" on public.class_members;
create policy "members primary manage" on public.class_members
  for all using (public.is_class_primary(class_id))
  with check (public.is_class_primary(class_id));
-- "members self" policy (student joins/leaves themselves) is unchanged

-- ----- quiz_assignments -----
drop policy if exists "assign teacher all" on public.quiz_assignments;
drop policy if exists "assign owner all" on public.quiz_assignments;
drop policy if exists "assign primary read" on public.quiz_assignments;

-- Quiz owner can manage their own assignments, BUT the target must be a class
-- they teach (primary or co), or a student in a class they teach.
create policy "assign owner all" on public.quiz_assignments
  for all using (
    exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid())
    and (
      (class_id is not null and public.is_class_teacher(class_id))
      or
      (student_id is not null and public.is_teacher_for_student(student_id))
    )
  );

-- Primary teacher of the target class sees all assignments (incl. those by co-teachers)
create policy "assign primary read" on public.quiz_assignments
  for select using (
    class_id is not null and public.is_class_primary(class_id)
  );

-- ----- quiz_attempts -----
drop policy if exists "attempts teacher read" on public.quiz_attempts;
drop policy if exists "attempts quiz owner read" on public.quiz_attempts;
drop policy if exists "attempts primary read" on public.quiz_attempts;

-- Quiz owner sees attempts on their quizzes
create policy "attempts quiz owner read" on public.quiz_attempts
  for select using (
    exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid())
  );

-- Primary teacher of any class the student is in sees all attempts for that student
create policy "attempts primary read" on public.quiz_attempts
  for select using (public.is_primary_for_student(student_id));

-- ----- attempt_answers -----
drop policy if exists "ans teacher read" on public.attempt_answers;
drop policy if exists "ans quiz owner read" on public.attempt_answers;
drop policy if exists "ans primary read" on public.attempt_answers;

create policy "ans quiz owner read" on public.attempt_answers
  for select using (
    exists (
      select 1 from public.quiz_attempts a
      join public.quizzes q on q.id = a.quiz_id
      where a.id = attempt_id and q.owner_id = auth.uid()
    )
  );

create policy "ans primary read" on public.attempt_answers
  for select using (
    exists (
      select 1 from public.quiz_attempts a
      where a.id = attempt_id and public.is_primary_for_student(a.student_id)
    )
  );

-- ----- student_logins (governance: primary-only) -----
drop policy if exists "logins read by teacher" on public.student_logins;
drop policy if exists "logins read by primary" on public.student_logins;
create policy "logins read by primary" on public.student_logins
  for select using (public.is_primary_for_student(user_id));

-- ----- student_password_resets (primary-only) -----
drop policy if exists "pwresets read by teacher" on public.student_password_resets;
drop policy if exists "pwresets read by primary" on public.student_password_resets;
create policy "pwresets read by primary" on public.student_password_resets
  for select using (public.is_primary_for_student(student_id));

-- ============ quizzes.subject (free-form text label) ============
alter table public.quizzes
  add column if not exists subject text;
create index if not exists quizzes_subject_idx on public.quizzes (subject);
