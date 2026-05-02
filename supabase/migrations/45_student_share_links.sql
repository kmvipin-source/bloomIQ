-- =============================================================================
-- Migration 45 — student_share_links: parent-shareable progress reports
-- -----------------------------------------------------------------------------
-- Phase 4a (Item #4 from the 2026-05-02 strategy session): instead of a
-- raw PDF dump, a student generates a token-based read-only URL that
-- anyone with the link can open — typically pasted into a parent
-- WhatsApp / SMS / email. The parent sees Bloom mastery + recent tests
-- without needing a BloomIQ account.
--
-- Schema:
--   - token        random URL-safe id (32 chars), generated client-side or
--                  server-side via crypto.randomUUID() / nanoid. Unique.
--   - user_id      the student. RLS: only the student can create/revoke
--                  their own. Public reads happen via the API route using
--                  the service-role client, NOT via RLS.
--   - scope        what's exposed at /share/<token>. 'mastery' = Bloom
--                  chart + recent tests headline. 'full' = same plus the
--                  full per-question time breakdown (Premium Plus).
--                  Future: 'certificate', 'transcript', etc.
--   - expires_at   default = now() + 30 days. Auto-revokes the link.
--                  Student can override with a different duration.
--   - revoked_at   set by the student to kill the link early.
--
-- Phase 4b (parent-email monthly digest cron) is a separate session —
-- this migration sets up just the share-link primitive.
-- =============================================================================

create table public.student_share_links (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  scope       text not null default 'mastery'
              check (scope in ('mastery', 'full', 'certificate')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '30 days'),
  revoked_at  timestamptz,

  -- A token must be at least 16 chars to avoid easy guessing. Generated
  -- via crypto.randomUUID() in the API route which gives 36 chars.
  constraint share_links_token_length check (length(token) >= 16)
);

create index student_share_links_user_id_idx
  on public.student_share_links (user_id);
create index student_share_links_token_idx
  on public.student_share_links (token);
create index student_share_links_active_idx
  on public.student_share_links (expires_at)
  where revoked_at is null;

-- Row-Level Security: only the student can manage their own links.
-- Public reads via /share/[token] use the service-role admin client and
-- bypass RLS — the API does its own validity check (not revoked, not
-- expired) before returning data.
alter table public.student_share_links enable row level security;

create policy share_links_owner_select
  on public.student_share_links
  for select to authenticated
  using (user_id = auth.uid());

create policy share_links_owner_insert
  on public.student_share_links
  for insert to authenticated
  with check (user_id = auth.uid());

create policy share_links_owner_update
  on public.student_share_links
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy share_links_owner_delete
  on public.student_share_links
  for delete to authenticated
  using (user_id = auth.uid());

notify pgrst, 'reload schema';
