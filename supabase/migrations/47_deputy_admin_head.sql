-- =============================================================================
-- 47_deputy_admin_head.sql
-- =============================================================================
-- Business-continuity feature. Until this migration, every school had exactly
-- one super_teacher (the "Admin Head"), and all school-level admin actions
-- (rename school, upload logo, view full school dashboard, transfer the role,
-- etc.) required them. If they went on unplanned leave, the school was stuck.
--
-- This migration introduces "Deputies" — additional super_teachers in the same
-- school. The model is purely role-based: a Deputy is anyone with
-- profiles.role = 'super_teacher' and profiles.school_id = X who is NOT
-- bound to that school via schools.super_teacher_id (which still names the
-- single Head). Schema-wise nothing structural changes — we just relax the
-- update RLS so Deputies can act, and add an integrity guard.
--
-- Permissions, enforced in API code:
--   - Head: full powers, including promote/demote deputies and transfer Head.
--   - Deputy: full powers EXCEPT promote/demote deputies and transfer Head.
--
-- Deputy cap (max 2 per school) is enforced in /api/admin/school/deputy,
-- not in SQL — Postgres can't elegantly enforce "count(role='super_teacher'
-- where school_id=X excluding the Head) <= 2" with a CHECK constraint, and a
-- trigger would surface confusingly, so the API is the single source of truth.
-- =============================================================================

-- ---------- schools update RLS ----------
-- Old policy (from migration 31): only the Head could update.
--   for update using (super_teacher_id = (select auth.uid()))
-- New policy: any super_teacher whose school_id matches this row can update.
-- The Head is still required for promote/demote (those happen via API on
-- profiles, not on schools), and the unique constraint
-- schools_one_per_admin still enforces one Head per school.
drop policy if exists "schools update" on public.schools;
create policy "schools update" on public.schools
  for update using (
    public.is_platform_admin()
    or super_teacher_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.role = 'super_teacher'
        and p.school_id = schools.id
    )
  ) with check (
    public.is_platform_admin()
    or super_teacher_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.role = 'super_teacher'
        and p.school_id = schools.id
    )
  );

-- ---------- helper: count_school_deputies(school_id) ----------
-- Used by API and (optionally) UI to show "you have N/2 deputies".
-- Excludes the Head. SECURITY DEFINER so it doesn't trip RLS recursion
-- on profiles.
create or replace function public.count_school_deputies(sid uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int
  from public.profiles p
  left join public.schools s on s.super_teacher_id = p.id
  where p.school_id = sid
    and p.role = 'super_teacher'
    and (s.id is null or s.id <> sid);
$$;

-- ---------- helper: is_school_admin(school_id) ----------
-- Boolean: am I either the Head OR a Deputy of this school? Used by future
-- RLS policies where we want to allow either. Not strictly required for
-- this migration but cheap to add and useful for downstream cleanup.
create or replace function public.is_school_admin(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'super_teacher'
      and p.school_id = sid
  );
$$;

-- Reload PostgREST schema cache.
notify pgrst, 'reload schema';
