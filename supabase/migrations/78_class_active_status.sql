-- =============================================================================
-- 78_class_active_status.sql
-- -----------------------------------------------------------------------------
-- Soft-delete for classes. Admin Head can "deactivate" a class and later
-- reactivate it with one click — physical deletion is intentionally not
-- supported because every class is the parent of student attempts, quiz
-- assignments, retake requests, and co-teacher invites. A physical delete
-- would either cascade-destroy historical learning data (bad) or refuse
-- to delete on FK violations (worse — the admin would think the system
-- is broken).
--
-- Approach (per Vipin, 2026-05-12):
--   - classes.status TEXT NOT NULL DEFAULT 'active', values 'active' | 'inactive'.
--   - classes.deactivated_at TIMESTAMPTZ NULL — for audit / display.
--   - classes.deactivated_by UUID NULL → profiles.id (who clicked the button).
--   - Inactive classes:
--       * stay in the DB intact (rows, attempts, assignments preserved)
--       * disappear from teacher/student "active class" lists via app filters
--       * remain visible to the school admin with a clear "Inactive" badge
--         and a Reactivate button
--   - Reactivation is one click: status='active', deactivated_at=NULL,
--     deactivated_by=NULL.
--
-- Posture:
--   * Additive only. No data drops, no rewrites.
--   * Defaults make every existing row 'active' implicitly — zero
--     migration risk for the pilot DB.
--   * Idempotent — IF NOT EXISTS guards make this safe to re-run.
--
-- Run order: after 77.
-- =============================================================================

alter table public.classes
  add column if not exists status text not null default 'active',
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id);

-- Guard rail: only the two known states. Future expansion (e.g., 'archived')
-- adds a new value here; otherwise a typo on the admin route surfaces fast.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'classes_status_chk'
  ) then
    alter table public.classes
      add constraint classes_status_chk check (status in ('active', 'inactive'));
  end if;
end$$;

comment on column public.classes.status is
  'active | inactive. Inactive classes are soft-deleted — preserved in the DB '
  'for audit + reactivation but hidden from teacher/student class lists. '
  'Admin Head can reactivate with one click. Physical deletion is not supported '
  'because classes are the parent of attempts/assignments/invites. Migration 78.';

comment on column public.classes.deactivated_at is
  'When the class was last deactivated. NULL when active. Migration 78.';

comment on column public.classes.deactivated_by is
  'Profile id of the admin who deactivated the class. NULL when active. '
  'Used for the audit line on the class card. Migration 78.';

-- Partial index for the common "list active classes" query path on dashboards.
create index if not exists classes_active_school_idx
  on public.classes (school_id, created_at desc)
  where status = 'active';

-- Reload PostgREST schema cache so the JS layer sees the new columns
-- without a server restart.
notify pgrst, 'reload schema';
