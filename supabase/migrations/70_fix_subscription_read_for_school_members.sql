-- =============================================================================
-- 70_fix_subscription_read_for_school_members.sql
-- -----------------------------------------------------------------------------
-- D3 fix (caught by scripts/test-rls.js on 2026-05-11):
--
-- A super_teacher (Admin Head / Deputy) could NOT read their own school's
-- subscription row via PostgREST. The old policy used an inline exists()
-- subquery that read `public.profiles` — which itself goes through RLS,
-- producing a subtle evaluation order issue that hid the row.
--
-- This rewrite uses the existing SECURITY-DEFINER helpers
--   public.current_user_school_id()  -- migration 31
--   public.is_platform_admin()       -- migration 22
-- which bypass RLS recursion on `profiles`. Same intent, unambiguous.
--
-- The policy still rejects every cross-tenant read, every anonymous read,
-- and every read by an independent (school_id IS NULL) student.
--
-- Safe to run on production. Idempotent.
-- =============================================================================

drop policy if exists "subs select" on public.subscriptions;

create policy "subs select" on public.subscriptions
  for select using (
    -- (A) I own this subscription directly (independent student case).
    user_id = (select auth.uid())

    -- (B) This is a school sub and I belong to that school. Uses the
    --     SECURITY-DEFINER helper so the inner profiles lookup doesn't
    --     re-evaluate RLS on profiles (which was the bug).
    or (
      school_id is not null
      and school_id = public.current_user_school_id()
    )

    -- (C) Platform admin sees everything. Powers /admin/* dashboards.
    or public.is_platform_admin()
  );

comment on policy "subs select" on public.subscriptions is
  'A user can SELECT a subscription row if it is theirs personally, or if it belongs to their school, or they are a platform admin. Migration 70 rewrite uses SECURITY DEFINER helpers to avoid RLS recursion on profiles.';

notify pgrst, 'reload schema';
