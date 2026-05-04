-- =============================================================================
-- 51_fk_covering_indexes.sql
-- =============================================================================
-- Supabase advisor INFO: 7 foreign keys lack covering indexes. Without them,
-- DELETE / UPDATE on the parent row triggers a sequential scan of the child
-- table to enforce ON DELETE SET NULL / CASCADE behavior. Six of the seven FKs
-- here use SET NULL or CASCADE, so a parent profile/plan/quiz delete walks
-- the entire child table.
--
-- All seven added as plain btree on the FK column.
-- =============================================================================

create index if not exists plan_change_proposals_approved_by_idx
  on public.plan_change_proposals (approved_by);
create index if not exists plan_change_proposals_parent_plan_id_idx
  on public.plan_change_proposals (parent_plan_id);
create index if not exists plan_change_proposals_rejected_by_idx
  on public.plan_change_proposals (rejected_by);

create index if not exists plans_approved_by_idx
  on public.plans (approved_by);
create index if not exists plans_created_by_idx
  on public.plans (created_by);

create index if not exists quiz_retake_requests_decided_by_idx
  on public.quiz_retake_requests (decided_by);
create index if not exists quiz_retake_requests_quiz_id_idx
  on public.quiz_retake_requests (quiz_id);
