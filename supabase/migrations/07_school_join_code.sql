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
