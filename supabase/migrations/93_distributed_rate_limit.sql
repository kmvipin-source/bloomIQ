-- supabase/migrations/93_distributed_rate_limit.sql
-- ==========================================================================
-- Distributed (DB-backed) rate-limit counters (P2.10).
--
-- Why
-- ---
-- lib/rateLimit.ts currently uses an in-process Map. On Vercel that map
-- is per-lambda-instance, so a free-tier abuser can cycle through
-- instances by spamming requests and trivially exceed limits. The code
-- already acknowledges this is N×-bypassable.
--
-- This table backs a per-user-per-hour-per-route counter. Each AI route
-- does:
--   1. Compute the current `bucket_start` = floor(now / 1h)
--   2. INSERT (...) ON CONFLICT (user_id, route, bucket_start) DO UPDATE
--      SET count = count + 1 RETURNING count
--   3. If returned count > limit, return 429.
--
-- The upsert is one round-trip and pgvector-grade Supabase regions
-- typically resolve it in < 3ms.
--
-- Why hourly buckets and not a leaky bucket: the abuse model we're
-- defending against is "burst 1000 generations in 5 minutes to drain my
-- Groq quota," not "produce 30 RPS sustained traffic". An hourly cap is
-- both simpler and sufficient.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  route        text        NOT NULL,
  -- The hour the counter belongs to. Computed as
  --   date_trunc('hour', now() AT TIME ZONE 'UTC')
  -- by the caller so different routes can share the bucketing.
  bucket_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, route, bucket_start)
);

-- Hot path index — the bucket_start filter is always > now() - 1h, so
-- queries skim the smallest tail of the table. A monthly cleanup job
-- (DELETE WHERE bucket_start < now() - interval '7 days') keeps the
-- table compact; no need for partitioning at our scale.
CREATE INDEX IF NOT EXISTS rate_limit_counters_bucket_idx
  ON rate_limit_counters (bucket_start DESC);

-- RLS: counters are read-only to the user they belong to (so a user can
-- check their own remaining quota if a future UI surfaces it), and
-- writable only by service-role (every route uses supabaseAdmin to
-- write). No teacher can read another teacher's counters.
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY rate_limit_counters_self_read
  ON rate_limit_counters
  FOR SELECT
  USING (user_id = auth.uid());

-- Service-role bypass is handled by the global server-role policy
-- pattern from migration 73; no per-table policy needed for writes.

COMMENT ON TABLE rate_limit_counters IS
  'Per-user-per-route hourly request counts. Replaces lib/rateLimit.ts in-process Map. UPSERT on (user_id, route, bucket_start) on every request; route handlers compare against per-route limits from lib/rateLimitDb.ts.';

-- ==========================================================================
-- Atomic increment RPC.
--
-- We expose this as a SECURITY DEFINER function so the calling code is
-- ONE round-trip ("give me the new count for this bucket") instead of
-- two ("select" then "update"). The function is the only correct way to
-- increment — direct UPDATE/INSERT races on concurrent calls.
-- ==========================================================================

CREATE OR REPLACE FUNCTION rpc_rate_limit_increment(
  p_user_id   uuid,
  p_route     text,
  p_bucket    timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count integer;
BEGIN
  INSERT INTO rate_limit_counters (user_id, route, bucket_start, count, updated_at)
  VALUES (p_user_id, p_route, p_bucket, 1, now())
  ON CONFLICT (user_id, route, bucket_start)
  DO UPDATE SET count = rate_limit_counters.count + 1, updated_at = now()
  RETURNING count INTO new_count;

  RETURN new_count;
END;
$$;

REVOKE ALL ON FUNCTION rpc_rate_limit_increment(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_rate_limit_increment(uuid, text, timestamptz) TO authenticated, service_role;

COMMENT ON FUNCTION rpc_rate_limit_increment(uuid, text, timestamptz) IS
  'Atomic counter increment for the rate-limit table. Returns the new count for the current bucket. Used by lib/rateLimitDb.ts on every protected AI route entry. SECURITY DEFINER so RLS does not block the write; the function only writes its own argument, no fan-out.';
