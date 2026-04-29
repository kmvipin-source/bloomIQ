-- BloomIQ: full reset + rebuild.
drop schema if exists public cascade;
create schema public;
grant all on schema public to postgres, anon, authenticated, service_role;
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ==========================================================
-- File: supabase/schema.sql
-- ==========================================================
-- BloomIQ schema. Run this entire file in Supabase SQL Editor.
-- Safe to re-run: drops existing tables first.

drop table if exists public.attempt_answers cascade;
drop table if exists public.quiz_attempts cascade;
drop table if exists public.quiz_questions cascade;
drop table if exists public.quizzes cascade;
drop table if exists public.question_bank cascade;
drop table if exists public.alerts cascade;
drop table if exists public.profiles cascade;

-- ============ PROFILES ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('teacher','student')),
  full_name text,
  school text,
  grade text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "profiles read self" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles read all auth" on public.profiles
  for select to authenticated using (true);
create policy "profiles insert self" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles update self" on public.profiles
  for update using (auth.uid() = id);

-- ============ QUESTION BANK ============
create table public.question_bank (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  topic text,
  bloom_level text not null check (bloom_level in
    ('remember','understand','apply','analyze','evaluate','create')),
  stem text not null,
  options jsonb not null,           -- array of 4 strings
  correct_index int not null check (correct_index between 0 and 3),
  explanation text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz default now()
);
create index on public.question_bank (owner_id, status);
alter table public.question_bank enable row level security;
create policy "qb owner all" on public.question_bank
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
-- Students need to read approved questions when taking a quiz
create policy "qb read approved" on public.question_bank
  for select to authenticated using (status = 'approved');

-- ============ QUIZZES ============
create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  code text unique not null,
  time_limit_minutes int not null default 15,
  bloom_filter text[] default '{}',
  active boolean default true,
  created_at timestamptz default now()
);
create index on public.quizzes (code);
alter table public.quizzes enable row level security;
create policy "quizzes owner all" on public.quizzes
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "quizzes read by code" on public.quizzes
  for select to authenticated using (true);

create table public.quiz_questions (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_id uuid not null references public.question_bank(id) on delete cascade,
  position int not null,
  primary key (quiz_id, question_id)
);
alter table public.quiz_questions enable row level security;
create policy "qq read auth" on public.quiz_questions
  for select to authenticated using (true);
create policy "qq write owner" on public.quiz_questions
  for all using (
    exists (select 1 from public.quizzes q
            where q.id = quiz_id and q.owner_id = auth.uid())
  );

-- ============ ATTEMPTS ============
create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz default now(),
  submitted_at timestamptz,
  score int default 0,
  total int default 0,
  time_taken_seconds int
);
create index on public.quiz_attempts (quiz_id);
create index on public.quiz_attempts (student_id);
alter table public.quiz_attempts enable row level security;
create policy "attempts student own" on public.quiz_attempts
  for all using (auth.uid() = student_id) with check (auth.uid() = student_id);
create policy "attempts teacher read" on public.quiz_attempts
  for select using (
    exists (select 1 from public.quizzes q
            where q.id = quiz_id and q.owner_id = auth.uid())
  );

create table public.attempt_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id uuid not null references public.question_bank(id) on delete cascade,
  selected_index int,
  is_correct boolean,
  bloom_level text
);
create index on public.attempt_answers (attempt_id);
alter table public.attempt_answers enable row level security;
create policy "ans student own" on public.attempt_answers
  for all using (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_id and a.student_id = auth.uid())
  ) with check (
    exists (select 1 from public.quiz_attempts a
            where a.id = attempt_id and a.student_id = auth.uid())
  );
create policy "ans teacher read" on public.attempt_answers
  for select using (
    exists (select 1 from public.quiz_attempts a
            join public.quizzes q on q.id = a.quiz_id
            where a.id = attempt_id and q.owner_id = auth.uid())
  );

-- ============ ALERTS (early warning) ============
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  quiz_id uuid references public.quizzes(id) on delete set null,
  kind text not null,
  message text not null,
  created_at timestamptz default now(),
  dismissed boolean default false
);
create index on public.alerts (student_id);
alter table public.alerts enable row level security;
create policy "alerts teacher read" on public.alerts
  for select using (
    exists (select 1 from public.quizzes q
            where q.id = quiz_id and q.owner_id = auth.uid())
  );
create policy "alerts teacher write" on public.alerts
  for all using (
    exists (select 1 from public.quizzes q
            where q.id = quiz_id and q.owner_id = auth.uid())
  );


-- ==========================================================
-- File: supabase/migrations/01_classes_and_assignments.sql
-- ==========================================================
-- BloomIQ: Classes + Quiz Assignments
-- Run in Supabase SQL Editor. Additive — does not drop existing tables.

-- ============ CLASSES ============
create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  grade text,
  join_code text unique not null,
  created_at timestamptz default now()
);
create index if not exists classes_owner_idx on public.classes (owner_id);
create index if not exists classes_join_code_idx on public.classes (join_code);
alter table public.classes enable row level security;

drop policy if exists "classes owner all" on public.classes;
create policy "classes owner all" on public.classes
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Authenticated users can look up a class by its join code (needed for the join flow)
drop policy if exists "classes read by code" on public.classes;
create policy "classes read by code" on public.classes
  for select to authenticated using (true);

-- ============ CLASS MEMBERS ============
create table if not exists public.class_members (
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (class_id, student_id)
);
create index if not exists class_members_student_idx on public.class_members (student_id);
alter table public.class_members enable row level security;

-- Students manage their own membership (join / leave)
drop policy if exists "members self" on public.class_members;
create policy "members self" on public.class_members
  for all using (auth.uid() = student_id) with check (auth.uid() = student_id);

-- Teachers manage members of classes they own
drop policy if exists "members teacher" on public.class_members;
create policy "members teacher" on public.class_members
  for all using (
    exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.classes c where c.id = class_id and c.owner_id = auth.uid())
  );

-- ============ QUIZ ASSIGNMENTS ============
-- Either class-wide (class_id set, student_id null) OR per-student (student_id set, class_id null).
create table if not exists public.quiz_assignments (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  class_id uuid references public.classes(id) on delete cascade,
  student_id uuid references public.profiles(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete cascade,
  due_at timestamptz,
  created_at timestamptz default now(),
  check ((class_id is not null and student_id is null) or (class_id is null and student_id is not null))
);
create index if not exists qa_quiz_idx on public.quiz_assignments (quiz_id);
create index if not exists qa_student_idx on public.quiz_assignments (student_id);
create index if not exists qa_class_idx on public.quiz_assignments (class_id);
alter table public.quiz_assignments enable row level security;

-- Teacher who owns the quiz manages all assignments for it
drop policy if exists "assign teacher all" on public.quiz_assignments;
create policy "assign teacher all" on public.quiz_assignments
  for all using (
    exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid())
  );

-- Students see assignments that target them directly OR target a class they're in
drop policy if exists "assign student read" on public.quiz_assignments;
create policy "assign student read" on public.quiz_assignments
  for select to authenticated using (
    student_id = auth.uid()
    or exists (
      select 1 from public.class_members m
      where m.class_id = quiz_assignments.class_id and m.student_id = auth.uid()
    )
  );


-- ==========================================================
-- File: supabase/migrations/02_student_modes_and_subs.sql
-- ==========================================================
-- BloomIQ: School-student usernames + Independent-student subscriptions
-- Additive. Run after migration 01.

-- ============ PROFILES extensions ============
alter table public.profiles
  add column if not exists username text unique,
  add column if not exists is_school_student boolean not null default false,
  add column if not exists parent_email text,
  add column if not exists parent_name text;

create index if not exists profiles_username_idx on public.profiles (username);

-- ============ SUBSCRIPTIONS (independent students) ============
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  tier text not null default 'free' check (tier in ('free','individual','premium')),
  status text not null default 'active' check (status in ('active','cancelled','expired')),
  started_at timestamptz default now(),
  expires_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists subs_user_idx on public.subscriptions (user_id);
alter table public.subscriptions enable row level security;

drop policy if exists "subs read self" on public.subscriptions;
create policy "subs read self" on public.subscriptions
  for select using (auth.uid() = user_id);

-- Inserts/updates happen via the service-role admin client, which bypasses RLS.

-- ============ NEW-USER TRIGGER (refreshed) ============
-- Honors role, full_name, username, is_school_student, parent_email, parent_name
-- coming through user metadata at signup / admin-create time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, role, full_name, username, is_school_student, parent_email, parent_name
  ) values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'student'),
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'username', ''),
    coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false),
    nullif(new.raw_user_meta_data->>'parent_email', ''),
    nullif(new.raw_user_meta_data->>'parent_name', '')
  )
  on conflict (id) do nothing;

  -- Independent students get a free subscription record so we have something to upgrade later.
  if coalesce(new.raw_user_meta_data->>'role', 'student') = 'student'
     and not coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false) then
    insert into public.subscriptions (user_id, tier, status)
    values (new.id, 'free', 'active')
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ==========================================================
-- File: supabase/migrations/03_governance_and_audit.sql
-- ==========================================================
-- BloomIQ: Governance & abuse-prevention for school-student accounts.
-- Additive. Run after migrations 01 and 02.

-- ============ LOGIN AUDIT ============
create table if not exists public.student_logins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ip text,
  user_agent text,
  created_at timestamptz default now()
);
create index if not exists logins_user_idx on public.student_logins (user_id, created_at desc);
alter table public.student_logins enable row level security;

-- Students can see their own login history
drop policy if exists "logins read self" on public.student_logins;
create policy "logins read self" on public.student_logins
  for select using (auth.uid() = user_id);

-- Teachers can see logins for students who are members of any class they own
drop policy if exists "logins read by teacher" on public.student_logins;
create policy "logins read by teacher" on public.student_logins
  for select using (
    exists (
      select 1
      from public.class_members m
      join public.classes c on c.id = m.class_id
      where m.student_id = student_logins.user_id
        and c.owner_id = auth.uid()
    )
  );

-- Inserts happen server-side via the service-role client (RLS bypassed).

-- ============ QUIZ ATTEMPT IP / DEVICE ============
alter table public.quiz_attempts
  add column if not exists ip text,
  add column if not exists user_agent text;

-- ============ PASSWORD-RESET AUDIT (optional but useful) ============
create table if not exists public.student_password_resets (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  reset_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now()
);
create index if not exists pwresets_student_idx on public.student_password_resets (student_id, created_at desc);
alter table public.student_password_resets enable row level security;

drop policy if exists "pwresets read by teacher" on public.student_password_resets;
create policy "pwresets read by teacher" on public.student_password_resets
  for select using (
    exists (
      select 1
      from public.class_members m
      join public.classes c on c.id = m.class_id
      where m.student_id = student_password_resets.student_id
        and c.owner_id = auth.uid()
    )
  );


-- ==========================================================
-- File: supabase/migrations/04_multi_teacher_classes.sql
-- ==========================================================
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


-- ==========================================================
-- File: supabase/migrations/05_topic_family.sql
-- ==========================================================
-- BloomIQ: Topic-family classification for progress comparison.
-- Each quiz gets a canonical, LLM-assigned topic family so progress can roll
-- up across "Apple anatomy" + "Apple varieties" + "Apples in nutrition" etc.

alter table public.quizzes
  add column if not exists topic_family text;

create index if not exists quizzes_topic_family_idx on public.quizzes (topic_family);
create index if not exists quizzes_owner_topic_family_idx on public.quizzes (owner_id, topic_family);


-- ==========================================================
-- File: supabase/migrations/06_class_naming_and_school.sql
-- ==========================================================
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


-- ==========================================================
-- File: supabase/migrations/07_school_join_code.sql
-- ==========================================================
-- BloomIQ: School join codes (so teachers can self-join, mirroring the class join flow).
-- Additive. Run after migration 06.

alter table public.schools
  add column if not exists join_code text;

-- Unique among non-null codes (existing rows can stay null until a code is generated)
create unique index if not exists schools_join_code_uniq
  on public.schools (join_code)
  where join_code is not null;

-- Allow an authenticated user to look up a school by join code (needed for the join flow)
drop policy if exists "schools read by code" on public.schools;
create policy "schools read by code" on public.schools
  for select to authenticated using (true);


-- ==========================================================
-- File: supabase/migrations/08_exam_papers.sql
-- ==========================================================
-- BloomIQ: Exam Paper Generator (printable papers, NOT online quizzes)
-- Teachers generate question papers per a custom template, edit, finalize, and print.

create table if not exists public.exam_papers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  school_name text,
  class_grade text,
  subject text,
  exam_date date,
  duration_minutes int default 60,
  total_marks int default 0,
  instructions text,
  status text not null default 'draft' check (status in ('draft','finalized')),
  created_at timestamptz default now()
);
create index if not exists exam_papers_owner_idx on public.exam_papers (owner_id, created_at desc);
alter table public.exam_papers enable row level security;
drop policy if exists "papers owner all" on public.exam_papers;
create policy "papers owner all" on public.exam_papers
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create table if not exists public.exam_paper_questions (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.exam_papers(id) on delete cascade,
  section_name text not null default 'Section A',
  position int not null,
  question_type text not null check (question_type in (
    'mcq','true_false','fill_blank','short_answer','long_answer','numerical'
  )),
  stem text not null,
  options jsonb,
  correct_answer text,
  explanation text,
  marks int not null default 1,
  bloom_level text check (bloom_level in ('remember','understand','apply','analyze','evaluate','create')),
  created_at timestamptz default now()
);
create index if not exists epq_paper_idx on public.exam_paper_questions (paper_id, position);
alter table public.exam_paper_questions enable row level security;
drop policy if exists "epq owner all" on public.exam_paper_questions;
create policy "epq owner all" on public.exam_paper_questions
  for all using (
    exists (select 1 from public.exam_papers p where p.id = paper_id and p.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.exam_papers p where p.id = paper_id and p.owner_id = auth.uid())
  );


-- ==========================================================
-- File: supabase/migrations/09_teacher_invites.sql
-- ==========================================================
-- BloomIQ: Pending teacher-class invites by email.
-- A class can be assigned to a teacher by email even before they sign up.
-- When the teacher creates their account with that email, the pending
-- invite is auto-claimed into a real class_teachers row.

-- ============ class_teacher_invites ============
create table if not exists public.class_teacher_invites (
  class_id uuid not null references public.classes(id) on delete cascade,
  email text not null,
  role text not null default 'primary' check (role in ('primary','co')),
  subject text,
  invited_at timestamptz default now(),
  invited_by uuid references public.profiles(id) on delete set null,
  primary key (class_id, email)
);
create index if not exists cti_email_idx on public.class_teacher_invites (lower(email));
alter table public.class_teacher_invites enable row level security;

-- RLS: only the school's Admin Head can manage invites for classes in their school.
drop policy if exists "cti super manage" on public.class_teacher_invites;
create policy "cti super manage" on public.class_teacher_invites
  for all using (
    exists (select 1 from public.classes c
            where c.id = class_id and public.is_super_for_school(c.school_id))
  ) with check (
    exists (select 1 from public.classes c
            where c.id = class_id and public.is_super_for_school(c.school_id))
  );

-- The class's primary teacher can also read & manage invites for it
-- (this is what powers the pending-co-teacher list on /teacher/classes/[id]).
drop policy if exists "cti primary manage" on public.class_teacher_invites;
create policy "cti primary manage" on public.class_teacher_invites
  for all using (public.is_class_primary(class_id))
  with check (public.is_class_primary(class_id));

-- Any teacher of the class (primary or co) can SEE the pending invite list
-- so they have visibility into who has been invited but hasn't signed up yet.
drop policy if exists "cti class teacher read" on public.class_teacher_invites;
create policy "cti class teacher read" on public.class_teacher_invites
  for select using (public.is_class_teacher(class_id));

-- ============ Extend handle_new_user to auto-claim pending invites ============
-- When a new auth.users row appears and a profile is created, look up any
-- class_teacher_invites whose email matches and convert them to class_teachers
-- rows. Then delete the invites. The class.owner_id mirror is updated when
-- the role is 'primary' to keep legacy paths working.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv_email text;
  inv_role  text;
  inv_class uuid;
  inv_subject text;
begin
  insert into public.profiles (
    id, role, full_name, username, is_school_student, parent_email, parent_name
  ) values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'student'),
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'username', ''),
    coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false),
    nullif(new.raw_user_meta_data->>'parent_email', ''),
    nullif(new.raw_user_meta_data->>'parent_name', '')
  )
  on conflict (id) do nothing;

  -- Independent students get a free subscription record.
  if coalesce(new.raw_user_meta_data->>'role', 'student') = 'student'
     and not coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false) then
    insert into public.subscriptions (user_id, tier, status)
    values (new.id, 'free', 'active')
    on conflict (user_id) do nothing;
  end if;

  -- Auto-claim any pending teacher invites for this email. Only does anything
  -- if the new user is a teacher (or they got a teacher role assigned later).
  inv_email := lower(new.email);
  if inv_email is not null then
    -- Pull the new user into the school of their first invite, if no school yet.
    update public.profiles p
       set school_id = (
         select c.school_id from public.classes c
         join public.class_teacher_invites cti on cti.class_id = c.id
         where lower(cti.email) = inv_email
         limit 1
       )
     where p.id = new.id and p.school_id is null;

    -- For each invite for this email, demote the previous primary if needed,
    -- then upsert a class_teachers row.
    for inv_class, inv_role, inv_subject in
      select cti.class_id, cti.role, cti.subject
      from public.class_teacher_invites cti
      where lower(cti.email) = inv_email
    loop
      if inv_role = 'primary' then
        update public.class_teachers
           set role = 'co'
         where class_id = inv_class and role = 'primary';
      end if;

      insert into public.class_teachers (class_id, teacher_id, role, subject)
      values (inv_class, new.id, inv_role, inv_subject)
      on conflict (class_id, teacher_id)
        do update set role = excluded.role, subject = excluded.subject;

      if inv_role = 'primary' then
        update public.classes set owner_id = new.id where id = inv_class;
      end if;
    end loop;

    -- Drop the invites we just claimed.
    delete from public.class_teacher_invites
     where lower(email) = inv_email;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ==========================================================
-- File: supabase/migrations/10_subscription_limits.sql
-- ==========================================================
-- BloomIQ: Subscription enforcement for independent students.
-- Caps free-tier independent students to a small number of quiz attempts
-- started per 24 hours. School students and paid tiers (individual / premium)
-- are uncapped. The trigger fires BEFORE INSERT on quiz_attempts so an over-
-- limit insert is rejected at the database level — it cannot be bypassed by
-- direct DB calls or the supabase-js client.

-- ============ Per-tier daily caps ============
create table if not exists public.subscription_limits (
  id int primary key default 1,
  free_daily_attempts int not null default 3,
  individual_daily_attempts int,   -- null = uncapped
  premium_daily_attempts int,      -- null = uncapped
  updated_at timestamptz default now(),
  check (id = 1)
);
insert into public.subscription_limits (id, free_daily_attempts)
values (1, 3)
on conflict (id) do nothing;

alter table public.subscription_limits enable row level security;
drop policy if exists "subs_limits read all" on public.subscription_limits;
create policy "subs_limits read all" on public.subscription_limits
  for select to authenticated using (true);

-- ============ Quota check trigger on quiz_attempts ============
create or replace function public.check_attempt_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_role text;
  is_school boolean;
  user_tier text;
  attempts_24h int;
  daily_cap int;
begin
  -- Independent students only; school students and teachers bypass.
  select role, coalesce(is_school_student, false)
    into user_role, is_school
    from public.profiles
    where id = new.student_id;

  if user_role <> 'student' or is_school then
    return new;
  end if;

  select tier into user_tier
    from public.subscriptions
    where user_id = new.student_id;

  -- Determine the cap for this tier.
  select case coalesce(user_tier, 'free')
           when 'free'       then free_daily_attempts
           when 'individual' then individual_daily_attempts
           when 'premium'    then premium_daily_attempts
           else free_daily_attempts
         end
    into daily_cap
    from public.subscription_limits
    where id = 1;

  -- null cap = unlimited.
  if daily_cap is null then
    return new;
  end if;

  -- Count DISTINCT quizzes the student opened in the last 24h.
  -- We count distinct quiz_ids (not rows) so a reload that creates a second
  -- attempt-row for the same quiz doesn't burn an extra cap slot. Allowing
  -- the same quiz to be retried within the 24-hour window is still subject
  -- to the cap, just that the SECOND open of an already-counted quiz is free.
  select count(distinct quiz_id) into attempts_24h
    from public.quiz_attempts
    where student_id = new.student_id
      and started_at >= now() - interval '24 hours'
      and quiz_id <> new.quiz_id;  -- the new attempt's quiz isn't counted; we check fresh slot

  if attempts_24h >= daily_cap then
    raise exception 'Daily free-attempt limit reached (% / day on the free plan). Upgrade or come back tomorrow.', daily_cap
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists check_attempt_quota_trigger on public.quiz_attempts;
create trigger check_attempt_quota_trigger
  before insert on public.quiz_attempts
  for each row execute function public.check_attempt_quota();

-- ============ Helper: how many free attempts does this user have left today? ============
create or replace function public.attempts_remaining_today()
returns integer
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  user_role text;
  is_school boolean;
  user_tier text;
  used int;
  cap int;
begin
  if auth.uid() is null then return null; end if;

  select role, coalesce(is_school_student, false)
    into user_role, is_school
    from public.profiles where id = auth.uid();

  if user_role <> 'student' or is_school then return null; end if;

  select tier into user_tier from public.subscriptions where user_id = auth.uid();

  select case coalesce(user_tier, 'free')
           when 'free'       then free_daily_attempts
           when 'individual' then individual_daily_attempts
           when 'premium'    then premium_daily_attempts
           else free_daily_attempts
         end
    into cap from public.subscription_limits where id = 1;

  if cap is null then return null; end if;

  select count(distinct quiz_id) into used
    from public.quiz_attempts
    where student_id = auth.uid()
      and started_at >= now() - interval '24 hours';

  return greatest(cap - used, 0);
end;
$$;


-- ==========================================================
-- File: supabase/migrations/11_school_subscriptions.sql
-- ==========================================================
-- BloomIQ: Subscription rows can also belong to a SCHOOL (not just a user).
-- Independent student subscriptions are keyed by user_id; school subscriptions
-- are keyed by school_id. Exactly one of the two is set per row.

alter table public.subscriptions
  add column if not exists school_id uuid references public.schools(id) on delete cascade;

-- Drop the old hard unique on user_id (since user_id can now be null for
-- school subscriptions). We replace it with two partial unique indexes.
alter table public.subscriptions drop constraint if exists subscriptions_user_id_key;
alter table public.subscriptions alter column user_id drop not null;

create unique index if not exists subs_one_per_user
  on public.subscriptions (user_id) where user_id is not null;
create unique index if not exists subs_one_per_school
  on public.subscriptions (school_id) where school_id is not null;

-- Exactly one of user_id / school_id is non-null. Idempotent guard so the
-- migration can be re-run safely.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'subs_owner_xor'
      and conrelid = 'public.subscriptions'::regclass
  ) then
    alter table public.subscriptions
      add constraint subs_owner_xor
      check ((user_id is not null) <> (school_id is not null));
  end if;
end $$;

create index if not exists subs_school_idx on public.subscriptions (school_id);

-- RLS: school subscriptions are readable by anyone in the school.
drop policy if exists "subs read school members" on public.subscriptions;
create policy "subs read school members" on public.subscriptions
  for select using (
    school_id is not null and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.school_id = subscriptions.school_id
    )
  );

