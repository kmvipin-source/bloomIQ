import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client.
 * Pass the user's access token from the client (Authorization: Bearer ...)
 * so RLS policies see the right auth.uid().
 */
// F22 update (QA): the requireAuthenticated() + requirePlatformAdmin()
// helpers now live in lib/apiAuth.ts. Step 1 (the 4 admin routes that
// had local requirePlatformAdmin copies) is shipped. Steps 2 (other
// admin routes with inline platform_admin checks) and 3 (~30 mutating
// non-admin routes adopting requireAuthenticated) are follow-up PRs.
// F22 note (QA): single-session enforcement (checking JWT iat against
// profiles.session_iat) is implemented in /api/auth/me but NOT in the
// other ~30 mutating API routes. Refactor: add requireAuthenticated(req)
// here that returns { user, session_iat } and 401s if iat is stale;
// migrate all mutating routes to use it. Touches ~30 files but the per-
// route delta is ~3 lines. Track alongside F171 (requirePlatformAdmin
// extraction) — they're sister refactors.
export function supabaseServer(accessToken?: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : undefined,
    }
  );
}

/**
 * Admin client — uses the service-role key. Bypasses RLS and can manage
 * auth users (createUser, deleteUser, etc.). NEVER expose this to the browser.
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local from Supabase dashboard → Settings → API."
    );
  }
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    key,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Extract bearer token from a Next.js Request. */
export function getBearer(req: Request): string | undefined {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return undefined;
  return h.replace(/^Bearer\s+/i, "").trim() || undefined;
}

/** Synthetic email scheme for school-student usernames (never delivered to). */
export const SCHOOL_STUDENT_DOMAIN = "bloomiq.invalid";
export function usernameToSyntheticEmail(username: string): string {
  return `${username.toLowerCase()}@${SCHOOL_STUDENT_DOMAIN}`;
}
