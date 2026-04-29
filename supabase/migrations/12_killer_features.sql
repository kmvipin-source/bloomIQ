-- BloomIQ: Four killer features for independent students.
--   1. Teach-Back   (Feynman-style explain-the-concept grader)
--   2. Misconception Detective (auto-diagnose the *specific* error behind a wrong answer)
--   3. Bloom Climber (daily 5-min streak that unlocks higher Bloom levels per topic)
--   4. Past-Paper X-Ray (upload a past exam → tag every question by Bloom level + topic)
--
-- All four are scoped to auth.uid(); RLS lets a student only see their own data.
-- ON CONFLICT predicates use partial-index-friendly WHERE clauses (see CONTEXT.md
-- on the ON CONFLICT saga).

-- =============================================================================
-- 1. TEACH-BACK
-- =============================================================================
-- A row per "I tried to explain X" attempt. We store the topic, the explanation,
-- the Bloom-level rubric scores (jsonb so we can evolve the rubric), strengths,
-- gaps, and the AI's Socratic follow-up. follow_up_answer is null until the
-- student answers the follow-up and we re-grade.
create table if not exists public.teach_back_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  topic           text not null,
  explanation     text not null,
  -- jsonb scores per Bloom level. Shape: { remember: 0..5, understand: 0..5, ... }
  bloom_scores    jsonb not null default '{}'::jsonb,
  -- Overall mastery 0..100 (composite of bloom_scores, weighted toward higher levels).
  overall_score   int  not null default 0,
  strengths       text[] not null default array[]::text[],
  gaps            text[] not null default array[]::text[],
  follow_up_q     text,                        -- AI-generated Socratic question
  follow_up_a     text,                        -- student's answer (null until they reply)
  follow_up_grade text,                        -- AI's verdict on the follow-up answer
  created_at      timestamptz not null default now()
);
create index if not exists tb_user_idx on public.teach_back_sessions (user_id, created_at desc);
create index if not exists tb_topic_idx on public.teach_back_sessions (user_id, topic);

alter table public.teach_back_sessions enable row level security;
drop policy if exists "tb own select" on public.teach_back_sessions;
drop policy if exists "tb own insert" on public.teach_back_sessions;
drop policy if exists "tb own update" on public.teach_back_sessions;
create policy "tb own select" on public.teach_back_sessions
  for select using (user_id = auth.uid());
create policy "tb own insert" on public.teach_back_sessions
  for insert with check (user_id = auth.uid());
create policy "tb own update" on public.teach_back_sessions
  for update using (user_id = auth.uid());

-- =============================================================================
-- 2. MISCONCEPTION DETECTIVE
-- =============================================================================
-- One row per *unique* misconception per user. If the same misconception fires
-- again, we increment strikes instead of inserting a duplicate. label is a
-- short slug ("photo-vs-resp"); detail is a human-readable sentence.
create table if not exists public.misconceptions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  topic             text,                       -- e.g. "Photosynthesis"
  bloom_level       text,                       -- copied from the question that triggered it
  label             text not null,              -- short slug for de-duping
  detail            text not null,              -- "You confused photosynthesis with respiration"
  evidence_q_ids    uuid[] not null default array[]::uuid[],  -- question_bank IDs that triggered this
  strikes           int  not null default 1,
  resolved          boolean not null default false,
  resolved_at       timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);
-- The same (user_id, label) combo should be unique; we use this for ON CONFLICT
-- when a misconception re-fires and we want to bump strikes + last_seen_at.
create unique index if not exists misc_user_label_unique
  on public.misconceptions (user_id, label) where user_id is not null;
create index if not exists misc_user_idx on public.misconceptions (user_id, last_seen_at desc);

alter table public.misconceptions enable row level security;
drop policy if exists "misc own select" on public.misconceptions;
drop policy if exists "misc own insert" on public.misconceptions;
drop policy if exists "misc own update" on public.misconceptions;
create policy "misc own select" on public.misconceptions
  for select using (user_id = auth.uid());
create policy "misc own insert" on public.misconceptions
  for insert with check (user_id = auth.uid());
create policy "misc own update" on public.misconceptions
  for update using (user_id = auth.uid());

-- =============================================================================
-- 3. BLOOM CLIMBER (daily streak)
-- =============================================================================
-- Per-user, per-topic, per-Bloom-level mastery state. Levels unlock in order:
-- once you nail Remember on a topic, Understand becomes the next "rung."
create table if not exists public.bloom_climber_state (
  user_id         uuid not null references auth.users(id) on delete cascade,
  topic           text not null,
  bloom_level     text not null,                -- one of the 6 Bloom levels
  mastered        boolean not null default false,
  attempts        int  not null default 0,
  correct         int  not null default 0,
  last_attempt_at timestamptz,
  primary key (user_id, topic, bloom_level)
);
create index if not exists bcs_user_idx on public.bloom_climber_state (user_id, last_attempt_at desc);

-- Per-user streak tracking. last_active_date is the calendar date in UTC of
-- the most recent climb day. current_streak resets to 0 if a day is skipped.
create table if not exists public.bloom_climber_streaks (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  current_streak   int  not null default 0,
  longest_streak   int  not null default 0,
  total_climbs     int  not null default 0,
  last_active_date date,
  updated_at       timestamptz not null default now()
);

alter table public.bloom_climber_state    enable row level security;
alter table public.bloom_climber_streaks  enable row level security;

drop policy if exists "bcs own select" on public.bloom_climber_state;
drop policy if exists "bcs own write"  on public.bloom_climber_state;
create policy "bcs own select" on public.bloom_climber_state
  for select using (user_id = auth.uid());
create policy "bcs own write" on public.bloom_climber_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "bcstr own select" on public.bloom_climber_streaks;
drop policy if exists "bcstr own write"  on public.bloom_climber_streaks;
create policy "bcstr own select" on public.bloom_climber_streaks
  for select using (user_id = auth.uid());
create policy "bcstr own write" on public.bloom_climber_streaks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =============================================================================
-- 4. PAST-PAPER X-RAY
-- =============================================================================
-- The summary row for a single uploaded paper. Per-question rows live in
-- past_paper_xray_questions so we can build a heatmap and show "study these 5".
create table if not exists public.past_paper_xrays (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  file_name         text,                       -- original upload name (display only)
  paper_title       text,                       -- AI-extracted (e.g. "CBSE Bio 2023")
  total_questions   int  not null default 0,
  bloom_breakdown   jsonb not null default '{}'::jsonb,  -- {remember: 5, understand: 9, ...}
  topic_breakdown   jsonb not null default '{}'::jsonb,  -- {"Cell Bio": 8, "Genetics": 4}
  recommendations   text[] not null default array[]::text[],  -- "Study these 5 things"
  created_at        timestamptz not null default now()
);
create index if not exists xr_user_idx on public.past_paper_xrays (user_id, created_at desc);

create table if not exists public.past_paper_xray_questions (
  id            uuid primary key default gen_random_uuid(),
  xray_id       uuid not null references public.past_paper_xrays(id) on delete cascade,
  position      int not null,
  question_text text not null,
  bloom_level   text,                           -- nullable if AI couldn't tag
  topic         text,
  created_at    timestamptz not null default now()
);
create index if not exists xrq_xray_idx on public.past_paper_xray_questions (xray_id, position);

alter table public.past_paper_xrays           enable row level security;
alter table public.past_paper_xray_questions  enable row level security;

drop policy if exists "xr own select" on public.past_paper_xrays;
drop policy if exists "xr own write"  on public.past_paper_xrays;
create policy "xr own select" on public.past_paper_xrays
  for select using (user_id = auth.uid());
create policy "xr own write" on public.past_paper_xrays
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "xrq own select" on public.past_paper_xray_questions;
drop policy if exists "xrq own write"  on public.past_paper_xray_questions;
-- Question rows are accessible if you can see the parent xray.
create policy "xrq own select" on public.past_paper_xray_questions
  for select using (
    exists (
      select 1 from public.past_paper_xrays p
      where p.id = past_paper_xray_questions.xray_id
        and p.user_id = auth.uid()
    )
  );
create policy "xrq own write" on public.past_paper_xray_questions
  for all using (
    exists (
      select 1 from public.past_paper_xrays p
      where p.id = past_paper_xray_questions.xray_id
        and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.past_paper_xrays p
      where p.id = past_paper_xray_questions.xray_id
        and p.user_id = auth.uid()
    )
  );
