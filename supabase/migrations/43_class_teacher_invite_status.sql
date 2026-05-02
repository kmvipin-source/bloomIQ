-- =============================================================================
-- Migration 43 — track accepted / declined / pending status on teacher invites.
-- -----------------------------------------------------------------------------
-- Previously the accept and decline endpoints deleted the invite row on
-- response, which left the super_teacher with no way to see "the teacher
-- declined." We now keep the row and flip status instead, so the school
-- admin sees Accepted / Rejected / Pending on /school/classes.
-- =============================================================================

alter table public.class_teacher_invites
  add column if not exists status text not null default 'pending'
    check (status in ('pending','accepted','declined')),
  add column if not exists responded_at timestamptz;

create index if not exists cti_class_status_idx
  on public.class_teacher_invites (class_id, status);

notify pgrst, 'reload schema';
