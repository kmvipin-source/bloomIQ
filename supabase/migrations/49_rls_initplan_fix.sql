-- =============================================================================
-- 49_rls_initplan_fix.sql
-- =============================================================================
-- Supabase performance advisor flagged auth_rls_initplan WARN on:
--   plan_change_proposals: proposals_admin_read, proposals_admin_write
--   student_share_links:   share_links_owner_select / insert / update / delete
--
-- Cause: auth.uid() called without a scalar subselect re-evaluates per row
-- under RLS. Wrapping in (select auth.uid()) lets the planner cache the
-- value once per query (initplan), eliminating the per-row call. Behavior
-- is identical; only the plan changes.
-- =============================================================================

-- ---------- student_share_links ----------
drop policy if exists share_links_owner_select on public.student_share_links;
drop policy if exists share_links_owner_insert on public.student_share_links;
drop policy if exists share_links_owner_update on public.student_share_links;
drop policy if exists share_links_owner_delete on public.student_share_links;

create policy share_links_owner_select on public.student_share_links
  for select
  using (user_id = (select auth.uid()));

create policy share_links_owner_insert on public.student_share_links
  for insert
  with check (user_id = (select auth.uid()));

create policy share_links_owner_update on public.student_share_links
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy share_links_owner_delete on public.student_share_links
  for delete
  using (user_id = (select auth.uid()));

-- ---------- plan_change_proposals ----------
drop policy if exists proposals_admin_read on public.plan_change_proposals;
drop policy if exists proposals_admin_write on public.plan_change_proposals;

create policy proposals_admin_read on public.plan_change_proposals
  for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.platform_admin = true
    )
  );

create policy proposals_admin_write on public.plan_change_proposals
  for all
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.platform_admin = true
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.platform_admin = true
    )
  );

notify pgrst, 'reload schema';
