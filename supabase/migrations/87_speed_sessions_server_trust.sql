-- =============================================================================
-- 87_speed_sessions_server_trust.sql
-- -----------------------------------------------------------------------------
-- Phase J: mirror migration 82's calibration_sessions pattern for the
-- Speed Trainer. Previously /api/speed/submit accepted client-supplied
-- correct_index per question and computed correct_count from that —
-- fully fabricable. New table stores the issued questions server-side
-- keyed by session_id + user_id; /submit re-reads correct_index and
-- ignores anything the client returns.
--
-- 6h TTL enforced in app code. RLS deny-all; service-role only.
-- =============================================================================

create table if not exists public.speed_sessions_issued (
  session_id  uuid        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  topic       text,
  questions   jsonb       not null,
  created_at  timestamptz not null default now()
);

comment on table public.speed_sessions_issued is
  'Short-lived server-trusted record of Speed Trainer questions issued per /start. /submit re-reads correct_index from here. Migration 87.';

create index if not exists speed_sessions_issued_user_idx
  on public.speed_sessions_issued (user_id, created_at desc);

alter table public.speed_sessions_issued enable row level security;

notify pgrst, 'reload schema';
