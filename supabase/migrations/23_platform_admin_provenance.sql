-- BloomIQ: Track who granted platform_admin to whom and when.
-- Powers the "Team" page at /admin/team where platform admins can see
-- provenance (who added each colleague, on what date) and revoke access.
-- Additive. Run after migration 22.

alter table public.profiles
  add column if not exists platform_admin_granted_at timestamptz,
  add column if not exists platform_admin_granted_by uuid
    references public.profiles(id) on delete set null;

create index if not exists profiles_platform_admin_granted_by_idx
  on public.profiles (platform_admin_granted_by)
  where platform_admin_granted_by is not null;

-- Reload PostgREST schema so the new columns are visible to the API
notify pgrst, 'reload schema';
