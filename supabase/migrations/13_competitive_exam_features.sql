-- BloomIQ: Four competitive-exam features.
--   1. Speed-Accuracy Trainer  — per-question timing, fast/right vs slow/wrong quadrant
--   2. Distractor Trap Detector — classify wrong picks by examiner-trap type
--   3. Mock Rank Predictor      — convert score → percentile → AIR estimate
--   4. Doubt-Clearing AI Tutor  — stateless, no DB persistence in v1
--
-- All tables here are additive (zero risk to existing flows). RLS scopes every
-- row to the owning user. Same partial-unique pattern as migration 11 anywhere
-- a unique index is needed (so we never trip the ON CONFLICT saga again).

-- =============================================================================
-- 1. SPEED-ACCURACY TRAINER
-- =============================================================================
-- One row per completed speed-trainer session. We store the questions + timing
-- as a single jsonb blob so the per-question detail can evolve without schema
-- migrations. Top-level columns are the rolled-up summary that drives the UI.
create table if not exists public.speed_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  topic               text,
  total_questions     int  not null default 0,
  correct_count       int  not null default 0,
  fast_right_count    int  not null default 0,
  slow_right_count    int  not null default 0,
  fast_wrong_count    int  not null default 0,
  slow_wrong_count    int  not null default 0,
  total_time_ms       int  not null default 0,
  -- jsonb shape: array of { stem, options, correct_index, picked, target_ms,
  --                         time_ms, was_right, bloom_level, explanation }
  questions           jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists ss_user_idx on public.speed_sessions (user_id, created_at desc);

alter table public.speed_sessions enable row level security;
drop policy if exists "ss own select" on public.speed_sessions;
drop policy if exists "ss own write"  on public.speed_sessions;
create policy "ss own select" on public.speed_sessions
  for select using (user_id = auth.uid());
create policy "ss own write" on public.speed_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- 2. DISTRACTOR TRAP DETECTOR
-- =============================================================================
-- Per-event log. Unlike misconceptions (which dedupe by label across attempts),
-- a trap is a single event tied to a specific wrong answer. We aggregate by
-- trap_type at read time for the profile view.
create table if not exists public.distractor_traps (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  attempt_id   uuid,                       -- FK omitted; quiz_attempts may be deleted independently
  question_id  uuid,                       -- same
  topic        text,
  trap_type    text not null,              -- slug: 'unit_confusion' | 'sign_error' | 'not_misread' | 'off_by_one' | 'plausible_formula' | 'partial_application' | 'mismatched_units' | 'distractor_close_value' | 'other'
  trap_label   text not null,              -- human-readable: "Unit conversion trap"
  detail       text not null,              -- "You computed in km/h but the answer wanted m/s"
  created_at   timestamptz not null default now()
);
create index if not exists dt_user_idx        on public.distractor_traps (user_id, created_at desc);
create index if not exists dt_user_type_idx   on public.distractor_traps (user_id, trap_type);

alter table public.distractor_traps enable row level security;
drop policy if exists "dt own select" on public.distractor_traps;
drop policy if exists "dt own write"  on public.distractor_traps;
create policy "dt own select" on public.distractor_traps
  for select using (user_id = auth.uid());
create policy "dt own write" on public.distractor_traps
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- 3. MOCK RANK PREDICTOR
-- =============================================================================
-- One row per prediction. We persist enough that the student can later look
-- back at "where I was in March" — useful for a progress narrative.
create table if not exists public.mock_rank_predictions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  attempt_id          uuid,                  -- nullable; predictions can be ad-hoc
  exam_type           text not null,         -- 'JEE_MAIN' | 'NEET' | 'CAT' | 'CUSTOM'
  raw_score           numeric not null default 0,
  max_score           numeric not null default 0,
  percentile          numeric,
  predicted_air       int,
  total_candidates    int,                   -- snapshot used for the AIR math
  target_air          int,                   -- nullable; user's stated goal
  gap_marks_needed    numeric,               -- estimated marks to hit target_air
  weakest_areas       text[] not null default array[]::text[],
  recommendations     text[] not null default array[]::text[],
  created_at          timestamptz not null default now()
);
create index if not exists mrp_user_idx on public.mock_rank_predictions (user_id, created_at desc);

alter table public.mock_rank_predictions enable row level security;
drop policy if exists "mrp own select" on public.mock_rank_predictions;
drop policy if exists "mrp own write"  on public.mock_rank_predictions;
create policy "mrp own select" on public.mock_rank_predictions
  for select using (user_id = auth.uid());
create policy "mrp own write" on public.mock_rank_predictions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- 4. DOUBT-CLEARING AI TUTOR
-- =============================================================================
-- v1 is intentionally stateless — no table. Each chat turn ships full client-
-- side history. Add a tutor_sessions/tutor_messages pair later if persistence
-- becomes worth the complexity.
