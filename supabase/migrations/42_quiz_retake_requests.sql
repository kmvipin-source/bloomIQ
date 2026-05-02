-- =============================================================================
-- Migration 42 — student retake / catch-up requests for missed quizzes.
-- -----------------------------------------------------------------------------
-- When a school student misses an assignment past its due_at, they can ask
-- the teacher who created the assignment for permission to take it late.
-- The request routes to whoever set assigned_by on quiz_assignments
-- (primary teacher OR co-teacher), so the right person sees it.
-- Approval extends due_at; denial closes the request out.
-- =============================================================================

create table if not exists public.quiz_retake_requests (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.quiz_assignments(id) on delete cascade,
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  note text,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id)
);

-- One pending request per (assignment, student) at a time.
create unique index if not exists qrr_one_pending_per_assignment_student
  on public.quiz_retake_requests (assignment_id, student_id)
  where status = 'pending';

create index if not exists qrr_teacher_status_idx
  on public.quiz_retake_requests (teacher_id, status, created_at desc);
create index if not exists qrr_student_idx
  on public.quiz_retake_requests (student_id, created_at desc);

alter table public.quiz_retake_requests enable row level security;

-- Student can read their own requests.
drop policy if exists "qrr student read own" on public.quiz_retake_requests;
create policy "qrr student read own" on public.quiz_retake_requests
  for select using ( student_id = (select auth.uid()) );

-- Student can insert a request for themselves.
drop policy if exists "qrr student insert own" on public.quiz_retake_requests;
create policy "qrr student insert own" on public.quiz_retake_requests
  for insert with check ( student_id = (select auth.uid()) );

-- Teacher can read requests routed to them.
drop policy if exists "qrr teacher read assigned" on public.quiz_retake_requests;
create policy "qrr teacher read assigned" on public.quiz_retake_requests
  for select using ( teacher_id = (select auth.uid()) );

-- Teacher can update (decide on) requests routed to them.
drop policy if exists "qrr teacher decide" on public.quiz_retake_requests;
create policy "qrr teacher decide" on public.quiz_retake_requests
  for update using ( teacher_id = (select auth.uid()) )
  with check ( teacher_id = (select auth.uid()) );

notify pgrst, 'reload schema';
