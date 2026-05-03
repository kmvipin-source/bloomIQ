-- =============================================================================
-- 48_acting_primary_class_teacher.sql
-- =============================================================================
-- Business-continuity Option B (see README session 2026-05-03). Until this
-- migration, the only way to cover a primary teacher's leave was to demote
-- them to co-teacher and promote a fill-in to primary — which forced the
-- admin to re-reassign on return. Per user feedback that's heavy-handed for
-- short leaves: "he might be back very soon within a week or so… it becomes
-- administrative overhead to keep reassigning."
--
-- This migration introduces a third class_teachers role: 'acting'. The
-- canonical primary stays 'primary' (keeps the title and ownership). The
-- fill-in is 'acting' — same powers via RLS, distinct label for UI. When
-- the original primary returns, the acting row is just deleted; no
-- re-reassign required.
--
-- Permissions model:
--   - 'primary'  → full powers, the canonical owner. owner_id mirrors them.
--   - 'acting'   → full powers, temporary cover. Doesn't change owner_id.
--   - 'co'       → can view + create assignments, can't manage class.
--
-- Cap: at most one acting cover per class (just like primary). Enforced via
-- a partial unique index that mirrors ct_one_primary_per_class.
-- =============================================================================

-- ---------- Extend the role enum ----------
alter table public.class_teachers
  drop constraint if exists class_teachers_role_check;
alter table public.class_teachers
  add constraint class_teachers_role_check
  check (role in ('primary', 'acting', 'co'));

-- ---------- One acting cover per class ----------
create unique index if not exists ct_one_acting_per_class
  on public.class_teachers (class_id) where role = 'acting';

-- ---------- Widen is_class_primary to include acting ----------
-- The function name keeps "primary" because it's used by 30+ RLS policies
-- across migrations 04, 09, 31, 38, etc., all of which mean "has primary-
-- level access to this class". Widening here means acting covers Just Work
-- everywhere those policies are checked — no per-policy edits required.
-- A separate is_class_canonical_primary helper (below) covers the rare
-- case where UI needs to distinguish the title-holder from the cover.
create or replace function public.is_class_primary(cid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.class_teachers
    where class_id = cid
      and teacher_id = auth.uid()
      and role in ('primary', 'acting')
  );
$$;

-- Same widening for the student-centric helper used by attempt-read RLS.
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
      and ct.role in ('primary', 'acting')
  );
$$;

-- ---------- New: distinguish canonical primary from acting cover ----------
-- For UI badges and "is this person the title-holder" checks. Returns true
-- only when the caller is the actual primary (role='primary'), excluding
-- acting cover. Most code shouldn't need this — RLS uses is_class_primary
-- which is now broad — but the /school/classes page uses it to label rows.
create or replace function public.is_class_canonical_primary(cid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.class_teachers
    where class_id = cid
      and teacher_id = auth.uid()
      and role = 'primary'
  );
$$;

-- ---------- Helper: who is the acting cover on this class? ----------
-- Returns the acting teacher's id, or NULL if no cover is active. Cheap
-- enough to call per-row in /school/classes hydration.
create or replace function public.class_acting_teacher(cid uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select teacher_id from public.class_teachers
  where class_id = cid and role = 'acting'
  limit 1;
$$;

notify pgrst, 'reload schema';
