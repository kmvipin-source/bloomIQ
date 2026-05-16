-- supabase/migrations/96_school_waitlist.sql
-- ==========================================================================
-- Public-facing school waitlist.
--
-- Why
-- ---
-- When the school_marketing_visible feature flag (migration 95) is OFF,
-- /pricing swaps the For-Schools section for a coming-soon CTA that
-- routes visitors to /schools-coming-soon. That page captures email +
-- (optional) school name. Without this table the POST 404s and the lead
-- is lost (Phase-1 QA finding F2).
--
-- Design
-- ------
-- One narrow table. Anonymous inserts are allowed (the whole point is
-- to catch leads from people who don't have accounts yet). Reads are
-- gated to platform admins only — we don't want anyone scraping the
-- waitlist. Each row records the IP-derived hash to make abuse
-- detectable without storing the raw IP (privacy-friendly default).
-- ==========================================================================

CREATE TABLE IF NOT EXISTS school_waitlist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  school_name   text,
  source        text NOT NULL DEFAULT 'schools-coming-soon',
  -- Stored as text not inet so we can prefix-hash easily and never
  -- need full IP semantics.
  ip_hash       text,
  user_agent    text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  contacted_at  timestamptz,
  contacted_by  uuid REFERENCES auth.users(id)
);

-- Normalize email to lowercase via a partial unique index so duplicate
-- signups from the same address don't pollute the list. Using a UNIQUE
-- INDEX rather than a column-level UNIQUE so we can revisit and allow
-- repeat signups later without an ALTER TABLE.
CREATE UNIQUE INDEX IF NOT EXISTS school_waitlist_email_unique
  ON school_waitlist (lower(email));

CREATE INDEX IF NOT EXISTS school_waitlist_created_at_idx
  ON school_waitlist (created_at DESC);

ALTER TABLE school_waitlist ENABLE ROW LEVEL SECURITY;

-- Anonymous + authenticated inserts both allowed. The API route does
-- its own validation (email shape, rate-limit hashing). The check
-- predicate is `true` because we accept any well-formed insert — the
-- column constraints + the API guard rails are the real gate.
DROP POLICY IF EXISTS school_waitlist_insert ON school_waitlist;
CREATE POLICY school_waitlist_insert ON school_waitlist
  FOR INSERT
  WITH CHECK (true);

-- Platform admins only can read or update (mark contacted).
DROP POLICY IF EXISTS school_waitlist_admin_read ON school_waitlist;
CREATE POLICY school_waitlist_admin_read ON school_waitlist
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.platform_admin = true
    )
  );

DROP POLICY IF EXISTS school_waitlist_admin_update ON school_waitlist;
CREATE POLICY school_waitlist_admin_update ON school_waitlist
  FOR UPDATE
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
