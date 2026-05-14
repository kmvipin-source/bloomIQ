-- =============================================================================
-- 84_phase_h_db_hardening.sql
-- -----------------------------------------------------------------------------
-- Phase H DB/RLS hardening — closes findings from the 2026-05-14 audit:
--
--   (a) live_sessions SELECT scope: prior policy `using (status in
--       ('lobby','running','ended'))` was effectively `using (true)` for
--       any authenticated user, exposing every session row (code,
--       host_teacher_id) across schools and enabling cross-school
--       session-code harvesting. Tighten to participants only.
--
--   (b) ON DELETE CASCADE → SET NULL on audit/finance tables:
--         - student_logins.user_id            (compliance: keep login audit)
--         - student_password_resets.{student_id, reset_by}  (compliance)
--         - subscription_invoice_archive.{school_id, subscription_id}
--           (finance retention)
--         - live_session_answers.question_id  (analytics history)
--       These columns ride on `references ... on delete cascade` from
--       migrations 03 / 21 / 64. Wiping a profile or question SHOULD NOT
--       destroy the historical record.
--
--   (c) quiz_attempts(student_id, submitted_at) composite index — hot
--       read path. Migration 76 only added the partial-on-raw_score
--       variant, which doesn't serve queries that don't filter on
--       raw_score (history listings, weekly digest, alerts).
--
-- Re-runnable via IF EXISTS / IF NOT EXISTS guards.
-- =============================================================================

-- (a) Tighten live_sessions SELECT
drop policy if exists "live_sessions players read" on public.live_sessions;
create policy "live_sessions players read" on public.live_sessions
  for select to authenticated using (
    exists (
      select 1 from public.live_session_players p
       where p.session_id = id
         and p.student_id = auth.uid()
    )
  );

-- (b) Compliance / finance: switch CASCADE → SET NULL where applicable.
-- We can't ALTER the action on an existing foreign key in-place, so the
-- pattern is: drop the constraint, re-create as SET NULL. The owning
-- column must be nullable.

-- student_logins.user_id
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema='public'
       and table_name='student_logins'
       and constraint_type='FOREIGN KEY'
       and constraint_name='student_logins_user_id_fkey'
  ) then
    alter table public.student_logins
      drop constraint student_logins_user_id_fkey;
    alter table public.student_logins
      alter column user_id drop not null;
    alter table public.student_logins
      add constraint student_logins_user_id_fkey
      foreign key (user_id) references public.profiles(id) on delete set null;
  end if;
end$$;

-- student_password_resets.student_id, reset_by
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema='public'
       and table_name='student_password_resets'
       and constraint_type='FOREIGN KEY'
       and constraint_name='student_password_resets_student_id_fkey'
  ) then
    alter table public.student_password_resets
      drop constraint student_password_resets_student_id_fkey;
    alter table public.student_password_resets
      alter column student_id drop not null;
    alter table public.student_password_resets
      add constraint student_password_resets_student_id_fkey
      foreign key (student_id) references public.profiles(id) on delete set null;
  end if;
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema='public'
       and table_name='student_password_resets'
       and constraint_type='FOREIGN KEY'
       and constraint_name='student_password_resets_reset_by_fkey'
  ) then
    alter table public.student_password_resets
      drop constraint student_password_resets_reset_by_fkey;
    alter table public.student_password_resets
      alter column reset_by drop not null;
    alter table public.student_password_resets
      add constraint student_password_resets_reset_by_fkey
      foreign key (reset_by) references public.profiles(id) on delete set null;
  end if;
end$$;

-- subscription_invoice_archive.{school_id, subscription_id}
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema='public'
       and table_name='subscription_invoice_archive'
       and constraint_type='FOREIGN KEY'
       and constraint_name='subscription_invoice_archive_school_id_fkey'
  ) then
    alter table public.subscription_invoice_archive
      drop constraint subscription_invoice_archive_school_id_fkey;
    alter table public.subscription_invoice_archive
      alter column school_id drop not null;
    alter table public.subscription_invoice_archive
      add constraint subscription_invoice_archive_school_id_fkey
      foreign key (school_id) references public.schools(id) on delete set null;
  end if;
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema='public'
       and table_name='subscription_invoice_archive'
       and constraint_type='FOREIGN KEY'
       and constraint_name='subscription_invoice_archive_subscription_id_fkey'
  ) then
    alter table public.subscription_invoice_archive
      drop constraint subscription_invoice_archive_subscription_id_fkey;
    alter table public.subscription_invoice_archive
      alter column subscription_id drop not null;
    alter table public.subscription_invoice_archive
      add constraint subscription_invoice_archive_subscription_id_fkey
      foreign key (subscription_id) references public.subscriptions(id) on delete set null;
  end if;
end$$;

-- live_session_answers.question_id — keep historical answers if the
-- source question is later deleted from question_bank.
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema='public'
       and table_name='live_session_answers'
       and constraint_type='FOREIGN KEY'
       and constraint_name='live_session_answers_question_id_fkey'
  ) then
    alter table public.live_session_answers
      drop constraint live_session_answers_question_id_fkey;
    alter table public.live_session_answers
      alter column question_id drop not null;
    alter table public.live_session_answers
      add constraint live_session_answers_question_id_fkey
      foreign key (question_id) references public.question_bank(id) on delete set null;
  end if;
end$$;

-- (c) Full composite index for the hot read path.
create index if not exists quiz_attempts_student_submitted_idx
  on public.quiz_attempts (student_id, submitted_at desc)
  where submitted_at is not null;

notify pgrst, 'reload schema';
