-- =============================================================================
-- 46_schools_logo_url.sql
-- =============================================================================
-- Adds a logo to a school. Surfaces in three places (in priority order):
--   1. /school home — top of page, replacing or augmenting the school name.
--   2. Sidebar BloomIQ branding row — small school logo for super-teachers.
--   3. /settings/profile super-teacher hero — instead of the initial-letter avatar.
--
-- Storage:
--   We use a public Supabase Storage bucket named "school-logos" so the URL
--   can be embedded as a plain <img src=...> with no signed-URL plumbing.
--   Logo files are tiny (typically <100 KB), so public read is acceptable.
--
-- Write policy:
--   Only super-teachers belonging to the school can upload / replace /
--   delete that school's logo. The path convention is `<school_id>/<filename>`,
--   which the policy enforces by parsing the first path component.
-- =============================================================================

alter table public.schools
  add column if not exists logo_url text;

-- Create the storage bucket (idempotent — the upsert pattern matches
-- Supabase's recommended migration style).
insert into storage.buckets (id, name, public)
  values ('school-logos', 'school-logos', true)
  on conflict (id) do update set public = excluded.public;

-- Public read — anyone can fetch a logo via its public URL (logos are
-- not sensitive; surfacing them on share-link pages later is a feature,
-- not a leak).
drop policy if exists "school_logos_public_read" on storage.objects;
create policy "school_logos_public_read"
  on storage.objects for select
  using (bucket_id = 'school-logos');

-- Write — only super-teachers belonging to that school can upload to
-- the path <school_id>/.... Enforced by parsing the first path
-- component out of `name` and joining to profiles.school_id.
drop policy if exists "school_logos_super_teacher_write" on storage.objects;
create policy "school_logos_super_teacher_write"
  on storage.objects for insert
  with check (
    bucket_id = 'school-logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_teacher'
        and p.school_id::text = split_part(name, '/', 1)
    )
  );

drop policy if exists "school_logos_super_teacher_update" on storage.objects;
create policy "school_logos_super_teacher_update"
  on storage.objects for update
  using (
    bucket_id = 'school-logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_teacher'
        and p.school_id::text = split_part(name, '/', 1)
    )
  );

drop policy if exists "school_logos_super_teacher_delete" on storage.objects;
create policy "school_logos_super_teacher_delete"
  on storage.objects for delete
  using (
    bucket_id = 'school-logos'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_teacher'
        and p.school_id::text = split_part(name, '/', 1)
    )
  );

-- Reload PostgREST so the new column is visible to API consumers without
-- waiting for the periodic schema cache refresh.
notify pgrst, 'reload schema';
