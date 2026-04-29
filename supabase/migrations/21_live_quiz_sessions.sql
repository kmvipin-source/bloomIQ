-- BloomIQ migration 21: live class Quiz mode (Kahoot-style sessions).
--
-- Adds three tables:
--   live_sessions          — one per teacher-hosted live quiz instance
--   live_session_players   — students who joined that lobby
--   live_session_answers   — per-question answers + scoring
--
-- Idempotent — safe to re-run.

create table if not exists public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  host_teacher_id uuid not null references public.profiles(id) on delete cascade,
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  code text not null unique,
  status text not null default 'lobby' check (status in ('lobby','running','ended')),
  current_question_idx int not null default 0,
  -- seconds per question, set when host clicks "Start"
  seconds_per_question int not null default 30,
  -- when current question went live (for client-side countdown)
  question_started_at timestamptz,
  started_at timestamptz default now(),
  ended_at timestamptz
);
create index if not exists live_sessions_code_idx on public.live_sessions(code);
create index if not exists live_sessions_host_idx on public.live_sessions(host_teacher_id);
alter table public.live_sessions enable row level security;
drop policy if exists "live_sessions host all" on public.live_sessions;
create policy "live_sessions host all" on public.live_sessions
  for all using (host_teacher_id = auth.uid()) with check (host_teacher_id = auth.uid());
drop policy if exists "live_sessions players read" on public.live_sessions;
create policy "live_sessions players read" on public.live_sessions
  for select to authenticated using (status in ('lobby','running','ended'));

create table if not exists public.live_session_players (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  display_name text,
  joined_at timestamptz default now(),
  score int not null default 0,
  last_seen_at timestamptz default now(),
  primary key (session_id, student_id)
);
alter table public.live_session_players enable row level security;
drop policy if exists "lsp self" on public.live_session_players;
create policy "lsp self" on public.live_session_players
  for all using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists "lsp host read" on public.live_session_players;
create policy "lsp host read" on public.live_session_players
  for select using (
    exists (select 1 from public.live_sessions s where s.id = session_id and s.host_teacher_id = auth.uid())
  );

create table if not exists public.live_session_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.question_bank(id) on delete cascade,
  question_idx int not null,
  selected_index int,
  is_correct boolean,
  time_taken_ms int,
  awarded_points int not null default 0,
  created_at timestamptz default now()
);
create index if not exists lsa_session_idx on public.live_session_answers(session_id);
create unique index if not exists lsa_unique on public.live_session_answers(session_id, student_id, question_idx);
alter table public.live_session_answers enable row level security;
drop policy if exists "lsa self" on public.live_session_answers;
create policy "lsa self" on public.live_session_answers
  for all using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists "lsa host read" on public.live_session_answers;
create policy "lsa host read" on public.live_session_answers
  for select using (
    exists (select 1 from public.live_sessions s where s.id = session_id and s.host_teacher_id = auth.uid())
  );
