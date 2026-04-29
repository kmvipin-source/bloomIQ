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
