-- =============================================================================
-- Migration 33 — class_members.roll_number
-- -----------------------------------------------------------------------------
-- Optional per-class roll-number (text — typically integers like "12" but
-- some schools use formats like "10A-12"; keep flexible). Surfaced on both
-- the individual Add Student form and the Bulk Add paste (Name, Roll
-- pairs). No uniqueness constraint — the field is informational, and
-- requiring uniqueness would rejection-spam teachers mid-paste.
-- =============================================================================
alter table public.class_members
  add column if not exists roll_number text;

-- Alphanumeric only — keep schools from pasting "12 / Section A" garbage.
alter table public.class_members drop constraint if exists class_members_roll_alnum;
alter table public.class_members
  add constraint class_members_roll_alnum
  check (roll_number is null or roll_number ~ '^[A-Za-z0-9]+$');

create index if not exists class_members_class_roll_idx
  on public.class_members (class_id, roll_number)
  where roll_number is not null;

notify pgrst, 'reload schema';
