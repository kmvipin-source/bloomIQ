-- BloomIQ: Three more retention/comprehension features.
--   1. AI Concept Visualizer  — animated SVG-frame slideshows
--   2. Spaced Repetition (SRS) — SM-2-style review queue keyed by question_id
--   3. Confidence Calibration — track accuracy by self-rated confidence band
--
-- Additive only; zero risk to existing flows. RLS scopes every row to the
-- owning user.

-- =============================================================================
-- 1. AI CONCEPT VISUALIZER
-- =============================================================================
-- One row per generated animation. Frames are stored as a jsonb array so the
-- shape can evolve (we may add audio narration URLs, alt text, etc. later
-- without a migration).
create table if not exists public.concept_animations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  topic       text not null,
  title       text,
  -- jsonb shape: array of { svg: string, caption: string, duration_ms: int }
  frames      jsonb not null default '[]'::jsonb,
  summary     text,
  created_at  timestamptz not null default now()
);
create index if not exists ca_user_idx on public.concept_animations (user_id, created_at desc);

alter table public.concept_animations enable row level security;
drop policy if exists "ca own select" on public.concept_animations;
drop policy if exists "ca own write"  on public.concept_animations;
create policy "ca own select" on public.concept_animations
  for select using (user_id = auth.uid());
create policy "ca own write" on public.concept_animations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- 2. SPACED REPETITION (SM-2 algorithm)
-- =============================================================================
-- One row per (user, question) pair currently in the review queue. We use the
-- partial-unique index pattern so we never trip the ON CONFLICT trap on the
-- enqueue path.
create table if not exists public.srs_reviews (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  question_id     uuid not null,                 -- references question_bank(id) — FK omitted so deletes cascade nicely if a question is removed
  easiness        numeric not null default 2.5,  -- SM-2 EF, never below 1.3
  interval_days   int  not null default 1,
  reps            int  not null default 0,
  last_rating     int,                            -- 0..5, last quality-of-recall rating
  due_at          date not null default current_date,  -- next review date
  last_reviewed_at timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists srs_user_q_unique
  on public.srs_reviews (user_id, question_id) where user_id is not null;
create index if not exists srs_due_idx on public.srs_reviews (user_id, due_at);

alter table public.srs_reviews enable row level security;
drop policy if exists "srs own select" on public.srs_reviews;
drop policy if exists "srs own write"  on public.srs_reviews;
create policy "srs own select" on public.srs_reviews
  for select using (user_id = auth.uid());
create policy "srs own write" on public.srs_reviews
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- 3. CONFIDENCE CALIBRATION
-- =============================================================================
-- Per-event log of (question, confidence_band, was_correct). Aggregated at
-- read time for the calibration profile chart.
create table if not exists public.confidence_calibrations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  question_id  uuid,                          -- nullable; question may not be in question_bank
  attempt_id   uuid,                          -- nullable; speed sessions don't create quiz_attempts
  source       text not null,                 -- 'speed' | 'quiz' | 'srs' — where the rating was captured
  confidence   int  not null,                 -- 1=guess, 2=probably-not, 3=probably, 4=sure
  was_correct  boolean not null,
  bloom_level  text,
  topic        text,
  created_at   timestamptz not null default now()
);
create index if not exists cc_user_idx on public.confidence_calibrations (user_id, created_at desc);
create index if not exists cc_user_band_idx on public.confidence_calibrations (user_id, confidence);

alter table public.confidence_calibrations enable row level security;
drop policy if exists "cc own select" on public.confidence_calibrations;
drop policy if exists "cc own write"  on public.confidence_calibrations;
create policy "cc own select" on public.confidence_calibrations
  for select using (user_id = auth.uid());
create policy "cc own write" on public.confidence_calibrations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
