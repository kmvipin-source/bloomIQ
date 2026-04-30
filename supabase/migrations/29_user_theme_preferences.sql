-- =============================================================================
-- Migration 29 — User theme preferences
-- -----------------------------------------------------------------------------
-- Adds two columns to profiles so a logged-in user's chosen theme + color
-- mode follow them across devices, not just the browser they signed up on.
--
-- The client still keeps the choice in localStorage for instant first-paint
-- (the inline init script in layout.tsx reads from there to avoid a flash
-- of unthemed content). On login, the /settings/appearance page can
-- reconcile localStorage <- profile and write through both.
--
-- Defaults match the constants in lib/theme.ts: emerald + light. Existing
-- users get these via the column DEFAULT — they don't see any change in
-- behavior unless they actively pick something else.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS theme       text NOT NULL DEFAULT 'emerald',
  ADD COLUMN IF NOT EXISTS color_mode  text NOT NULL DEFAULT 'light';

-- Constrain to known values. If we ever add a 6th theme, update this CHECK
-- in a new migration before deploying the new theme name.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_theme_known;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_theme_known
  CHECK (theme IN ('emerald', 'indigo', 'rose', 'amber', 'slate'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_color_mode_known;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_color_mode_known
  CHECK (color_mode IN ('light', 'dark'));

COMMENT ON COLUMN public.profiles.theme IS
  'Active visual theme name. One of: emerald, indigo, rose, amber, slate. Default emerald.';
COMMENT ON COLUMN public.profiles.color_mode IS
  'Active color mode. One of: light, dark. Default light.';
