-- =============================================================================
-- Migration 48 — single-session enforcement column
-- -----------------------------------------------------------------------------
-- supabase.auth.signOut({ scope: 'others' }) only revokes refresh tokens.
-- The access JWT stays valid until expiry (~1h) so a user signed in on
-- two devices keeps seeing their dashboard on both. We need server-side
-- per-request enforcement.
--
-- Pattern:
--   - On every successful login, stamp the new JWT's iat into
--     profiles.session_iat.
--   - On every gated request (/api/auth/me), decode the incoming JWT,
--     compare its iat against profiles.session_iat. If the JWT is older,
--     it belongs to a previous device — return 401, the layout redirects
--     to /login.
-- =============================================================================

alter table public.profiles
  add column if not exists session_iat bigint;

notify pgrst, 'reload schema';
