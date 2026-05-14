-- Migration 79 — sub-topic cache for the generate-context-v2 chips.
-- Vipin asked on 2026-05-13 for an "auto-detected sub-topic chip" feature
-- on /student/generate and /teacher/generate so users typing "ISO 8583" get
-- suggested sub-areas (data elements, MTI, bitmap parsing, …) without
-- having to know the field themselves. Implementation calls Gemini Flash
-- once per topic and caches here — same chips for everyone, expires after
-- 30 days so we can absorb model improvements.
--
-- One row per (lowercased) topic key. JSONB stores the array of chip
-- strings the model returned. Public-readable because the chips aren't
-- per-user — they're a property of the topic itself.

create table if not exists public.topic_subtopics (
  topic_key       text primary key,                 -- lowercased, trimmed
  topic_display   text not null,                    -- original casing for tooltips
  subtopics       jsonb not null default '[]'::jsonb,  -- string[] of chip labels
  model_used      text,                             -- "gemini-2.0-flash" / "groq-llama-3.1-70b" / etc.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Trim cache automatically by created_at when we get over the soft limit.
-- 30-day TTL handled at read time in lib/topicEnrichment helper.
create index if not exists topic_subtopics_created_idx
  on public.topic_subtopics (created_at desc);

alter table public.topic_subtopics enable row level security;

-- Anyone authenticated can READ the cache — chips aren't user-specific.
drop policy if exists "topic_subtopics read by authenticated" on public.topic_subtopics;
create policy "topic_subtopics read by authenticated" on public.topic_subtopics
  for select to authenticated using (true);

-- Only the service role writes (the /api/generate/subtopics route uses
-- supabaseAdmin to upsert). No user-token writes.
drop policy if exists "topic_subtopics no user writes" on public.topic_subtopics;
create policy "topic_subtopics no user writes" on public.topic_subtopics
  for insert to authenticated with check (false);

drop policy if exists "topic_subtopics no user updates" on public.topic_subtopics;
create policy "topic_subtopics no user updates" on public.topic_subtopics
  for update to authenticated using (false) with check (false);

-- Reload PostgREST schema cache so the new table is visible immediately.
notify pgrst, 'reload schema';
