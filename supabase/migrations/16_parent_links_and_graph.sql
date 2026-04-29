-- BloomIQ: Parent Dashboard (magic-link, no auth changes) + Concept Knowledge Graph cache.
--
-- Parent Dashboard design: instead of adding a 'parent' role to the auth
-- system (which would touch the signup/login surface), we generate a tokenized
-- read-only URL the student can share via WhatsApp/email. The token IS the
-- credential. Revocable. No parent account ever exists.
--
-- Knowledge Graph cache: building the graph requires a Groq call to infer
-- prerequisite relationships between topics. We cache the result so a parent
-- viewing the graph doesn't re-burn AI tokens on every refresh.

-- =============================================================================
-- 1. PARENT LINKS (magic-link parent dashboard)
-- =============================================================================
create table if not exists public.parent_invites (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references auth.users(id) on delete cascade,
  -- Random opaque token, ~32 chars. The token IS the credential — anyone with
  -- it can read the student's dashboard data via /api/parent/data?token=...
  token         text not null,
  parent_label  text,                            -- "Mom", "Dad" — optional, for the student's UI
  parent_email  text,                            -- not validated; just for the student to remember who they sent to
  revoked_at    timestamptz,                     -- null = active
  last_viewed_at timestamptz,                    -- bumped each time parent opens the link
  view_count    int  not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists parent_invites_token_unique on public.parent_invites (token);
create index if not exists parent_invites_student_idx on public.parent_invites (student_id, created_at desc);

alter table public.parent_invites enable row level security;
drop policy if exists "pi own select" on public.parent_invites;
drop policy if exists "pi own write"  on public.parent_invites;
-- Student can read/write their own rows.
create policy "pi own select" on public.parent_invites
  for select using (student_id = auth.uid());
create policy "pi own write" on public.parent_invites
  for all using (student_id = auth.uid()) with check (student_id = auth.uid());

-- The parent endpoint will use the SUPABASE_SERVICE_ROLE_KEY (bypassing RLS)
-- to look up rows by token. That's deliberate — tokens are the credential, and
-- we don't want random anon users to be able to enumerate the table.
-- The /api/parent/data route validates token + revoked_at before returning data.

-- =============================================================================
-- 2. KNOWLEDGE GRAPH CACHE
-- =============================================================================
-- One row per user, holding the most-recent computed graph as jsonb. We refresh
-- on-demand (button on the page) or after a significant change (future: hook
-- into background jobs). For now: one row per user, overwrite on rebuild.
create table if not exists public.knowledge_graphs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  -- jsonb shape:
  --   { nodes: [{ id, topic, mastery, n_questions, bloom_levels: [...] }],
  --     edges: [{ from, to, kind: 'prereq' | 'related' }] }
  graph       jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  computed_at timestamptz not null default now()
);

alter table public.knowledge_graphs enable row level security;
drop policy if exists "kg own select" on public.knowledge_graphs;
drop policy if exists "kg own write"  on public.knowledge_graphs;
create policy "kg own select" on public.knowledge_graphs
  for select using (user_id = auth.uid());
create policy "kg own write" on public.knowledge_graphs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
