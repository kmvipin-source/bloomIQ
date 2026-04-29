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
