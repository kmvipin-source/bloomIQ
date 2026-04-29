-- BloomIQ: Exam Sprint Mode.
-- ----------------------------------------------------------------------------
-- One row per user holding their target exam + date. The "today's mission"
-- compute happens server-side on read (no need for a per-day completion table
-- in v1 — we read recent activity from the existing feature tables instead).
--
-- Additive only; zero risk to existing flows. Same partial-unique pattern as
-- migration 11 (so we never trip the ON CONFLICT saga on signup again).

create table if not exists public.exam_sprint_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  exam_type   text not null,                -- 'JEE_MAIN' | 'NEET' | 'CAT' | 'CUSTOM'
  exam_label  text,                         -- nullable; only set when exam_type = CUSTOM
  exam_date   date not null,
  target_air  int,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists ess_date_idx on public.exam_sprint_settings (exam_date);

alter table public.exam_sprint_settings enable row level security;
drop policy if exists "ess own select" on public.exam_sprint_settings;
drop policy if exists "ess own write"  on public.exam_sprint_settings;
create policy "ess own select" on public.exam_sprint_settings
  for select using (user_id = auth.uid());
create policy "ess own write" on public.exam_sprint_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
