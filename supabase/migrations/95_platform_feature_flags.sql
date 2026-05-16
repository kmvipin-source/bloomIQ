-- supabase/migrations/95_platform_feature_flags.sql
-- ==========================================================================
-- Platform feature-flag system (staged-launch / pilot-allowlist).
--
-- Why
-- ---
-- ZCORIQ is launching independent learners first, then piloting with real
-- schools, then opening broadly. We need to flip features (and entire
-- signup paths) on and off WITHOUT redeploying, and we need to be able to
-- enable a feature for ONE school at a time during pilot.
--
-- The same generic infra will service every future staged rollout, e.g.
-- AI Coach v2, ZCORIQ Bloom Score v2 — not just the school launch.
--
-- Design
-- ------
-- Three tables, deliberately narrow:
--
--   platform_flags
--     ├── name (PK)            string slug e.g. "school_signup_enabled"
--     ├── global_default       bool — the fallback when no override matches
--     ├── description          plain English, surfaced in admin UI
--     ├── updated_by / _at     audit
--
--   platform_flag_overrides
--     ├── (flag_name, entity_type, entity_id) PK
--     ├── enabled              bool — TRUE = allow, FALSE = explicitly deny
--     ├── note                 plain English reason ("Greenfield Pilot Q3")
--     ├── added_by / _at       audit
--     ├── expires_at           nullable; auto-cleanup with a 90-day default
--
--   platform_flag_audit
--     ├── id, flag_name, action, actor_id, entity_type, entity_id,
--     │   before_state, after_state, reason, at
--
-- Evaluation order (implemented in lib/featureFlags.ts, NOT in SQL — a
-- per-request env-var override sits on top of all DB lookups so we have
-- a panic switch that doesn't depend on DB connectivity):
--
--   1. process.env.FLAG_<NAME>     ← panic / test override
--   2. per-user override           ← internal QA / demo accounts
--   3. per-school override         ← pilot allowlist
--   4. global_default              ← normal path
--   5. hardcoded safeDefault       ← DB outage fallback (never crash a page)
--
-- RLS
-- ---
-- Reads from these tables are platform-admin-only. The public never queries
-- them directly; the public endpoint /api/flags/public uses the service role
-- to evaluate flags server-side and returns only the booleans the client
-- needs to render correctly. This avoids leaking pilot allowlists.
-- ==========================================================================

-- ─── platform_flags ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_flags (
  name            text PRIMARY KEY,
  global_default  boolean NOT NULL,
  description     text NOT NULL DEFAULT '',
  updated_by      uuid REFERENCES auth.users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_flags ENABLE ROW LEVEL SECURITY;

-- Only platform admins can read/write directly. The public path goes
-- through a service-role server route.
DROP POLICY IF EXISTS platform_flags_admin_all ON platform_flags;
CREATE POLICY platform_flags_admin_all ON platform_flags
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.platform_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.platform_admin = true
    )
  );

-- ─── platform_flag_overrides ──────────────────────────────────────────────
-- entity_type is 'user' or 'school' today; the column is text so future
-- entity kinds (cohort, region) are additive without a schema change.
CREATE TABLE IF NOT EXISTS platform_flag_overrides (
  flag_name    text NOT NULL REFERENCES platform_flags(name) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('user','school')),
  entity_id    uuid NOT NULL,
  enabled      boolean NOT NULL,
  note         text NOT NULL DEFAULT '',
  added_by     uuid REFERENCES auth.users(id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,           -- nullable; null = no auto-expiry
  PRIMARY KEY (flag_name, entity_type, entity_id)
);

-- Plain composite index (NOT a partial index). An earlier draft tried
-- WHERE expires_at IS NULL OR expires_at > now(), but Postgres rejects
-- now() inside an index predicate because now() is STABLE, not
-- IMMUTABLE (partial-index predicates must be IMMUTABLE so the planner
-- can rely on them). The expiry filter happens in the application
-- evaluator (lib/featureFlags.ts) anyway — the row count is tiny
-- (handful of pilots per flag at most), so a plain composite index is
-- exactly enough to make the lookup point-fast.
CREATE INDEX IF NOT EXISTS platform_flag_overrides_lookup_idx
  ON platform_flag_overrides (flag_name, entity_type, entity_id);

-- F13 note (QA): when a user or school is deleted, the matching
-- platform_flag_overrides rows are left behind (no FK to auth.users
-- or schools because entity_id is polymorphic). Add a nightly cleanup
-- job: delete where entity_type='user' and entity_id not in (select id from auth.users)
-- and same for 'school'. Tiny volume; safe to defer until first pilot.

ALTER TABLE platform_flag_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_flag_overrides_admin_all ON platform_flag_overrides;
CREATE POLICY platform_flag_overrides_admin_all ON platform_flag_overrides
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.platform_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.platform_admin = true
    )
  );

-- ─── platform_flag_audit ──────────────────────────────────────────────────
-- Append-only. Every flag flip and every override mutation lands here.
-- We keep the rows forever (cheap; ops volume is tiny — handful per week).
CREATE TABLE IF NOT EXISTS platform_flag_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name      text NOT NULL,
  action         text NOT NULL,           -- 'create' | 'set_default' | 'add_override' | 'remove_override' | 'expire'
  actor_id       uuid REFERENCES auth.users(id),
  entity_type    text,                    -- nullable; only set for override actions
  entity_id      uuid,
  before_state   jsonb,
  after_state    jsonb,
  reason         text NOT NULL DEFAULT '',
  at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_flag_audit_flag_at_idx
  ON platform_flag_audit (flag_name, at DESC);

ALTER TABLE platform_flag_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_flag_audit_admin_read ON platform_flag_audit;
CREATE POLICY platform_flag_audit_admin_read ON platform_flag_audit
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.platform_admin = true
    )
  );

-- Insert-only via service role from the API routes; no public insert policy.
--
-- F20 note (QA): audit row 'at' uses Postgres now() (DB time). The
-- evaluator in lib/featureFlags.ts uses server Date.now() for cache
-- expiry. Two clocks: ops auditing dashboards that cross-correlate
-- audit timestamps with route-level telemetry must account for the
-- skew (usually <50ms, but document it).

-- ─── Seed the three starter flags ──────────────────────────────────────────
-- These match the README design recap. Defaults reflect the "launch
-- independent first, schools later" stance: marketing visible (so the
-- waitlist is discoverable), school signup OFF (so nobody slips through
-- before the pilot is ready), independent signup ON.
INSERT INTO platform_flags (name, global_default, description) VALUES
  ('school_marketing_visible',
   true,
   'Show the "For Schools" tier on /pricing and any school marketing surface. When OFF, the school card flips to a coming-soon waitlist CTA.'),
  ('school_signup_enabled',
   false,
   'Allow new school onboarding (Admin Head invitation via /api/admin/onboard-school) and the /login/school + /signup school paths. Existing schools and their users keep working regardless. When OFF, /login/school redirects to /schools-coming-soon.'),
  ('independent_signup_enabled',
   true,
   'Allow new independent learner signups via /signup?role=student. Kill switch in case of abuse spike.')
ON CONFLICT (name) DO NOTHING;
