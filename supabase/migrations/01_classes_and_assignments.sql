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
