-- BloomIQ migration 20: daily_drill_attempts
--
-- Records each Practice "smart drill" a student completes, for analytics +
-- streak tracking. Idempotent — safe to re-run.

create table if not exists public.daily_drill_attempts (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  score        int  not null default 0,
  total        int  not null default 0,
  items        jsonb not null default '[]'::jsonb,
  completed_at timestamptz not null default now()
);

create index if not exists dda_student_idx
  on public.daily_drill_attempts (student_id, completed_at desc);

alter table public.daily_drill_attempts enable row level security;

drop policy if exists "dda own select" on public.daily_drill_attempts;
drop policy if exists "dda own write"  on public.daily_drill_attempts;

create policy "dda own select" on public.daily_drill_attempts
  for select using (student_id = auth.uid());
create policy "dda own write" on public.daily_drill_attempts
  for all using (student_id = auth.uid()) with check (student_id = auth.uid());
