/**
 * lib/apiAuth.ts
 *
 * Shared auth helpers for API routes. Replaces the per-route copies of
 * `requirePlatformAdmin` (F171) and provides the canonical
 * `requireAuthenticated` (F22) that enforces single-session via JWT iat
 * vs profiles.session_iat.
 *
 * Why this file exists
 * --------------------
 * Before this refactor, ~10 admin routes each defined their own
 * `requirePlatformAdmin` function with identical bodies. Any change to
 * the auth surface (e.g. adding a structured-log line, adding a 2FA
 * gate, adjusting the error shape) had to land in 10 places — and in
 * practice often didn't, so we drifted. Same story for the per-route
 * single-session enforcement, which was never copied beyond
 * /api/auth/me — meaning a stolen access token issued before a
 * later sign-in elsewhere kept working on every mutating route.
 *
 * Contract
 * --------
 * Both helpers return a discriminated union. Use the `"error" in x`
 * pattern at the call site:
 *
 *   export async function POST(req: Request) {
 *     const auth = await requirePlatformAdmin(req);
 *     if ("error" in auth) return auth.error;
 *     const { user, admin } = auth;
 *     // ... real work
 *   }
 *
 * Migration plan
 * --------------
 * Step 1 (this PR): ship the helpers + migrate the 4 routes that have
 *   local `requirePlatformAdmin` copies — feature-flags + overrides +
 *   admin/users + admin/users/[id].
 * Step 2 (follow-up PR): migrate the other ~6 admin routes that use
 *   inline platform_admin checks (plan-proposals, team, etc.).
 * Step 3 (follow-up PR): migrate the ~30 mutating non-admin routes to
 *   `requireAuthenticated` to close the single-session gap.
 */

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

type SupabaseAdminClient = ReturnType<typeof supabaseAdmin>;
type SupabaseServerClient = ReturnType<typeof supabaseServer>;

export type AuthFailure = { error: NextResponse };
export type AuthSuccess = {
  user: User;
  /** Service-role client — bypasses RLS. */
  admin: SupabaseAdminClient;
  /** User-token client — RLS-respecting reads/writes as this user. */
  sb: SupabaseServerClient;
  /** Raw bearer token, for routes that need to forward auth (e.g. internal fetches). */
  token: string;
  sessionIat: number | null;
};
export type AuthResult = AuthFailure | AuthSuccess;

export type PlatformAdminSuccess = AuthSuccess & { platformAdmin: true };
export type PlatformAdminResult = AuthFailure | PlatformAdminSuccess;

/**
 * Decode the `iat` claim from a JWT (no signature verification — that
 * happened upstream when supabase-js accepted the token). Returns null
 * on any parse failure.
 *
 * Exported so /api/auth/me and /api/auth/claim-session can use the same
 * implementation (Finding #17 — three copies before this).
 */
export function decodeIat(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const obj = JSON.parse(json) as { iat?: number };
    return typeof obj.iat === "number" ? obj.iat : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the bearer token to a user, look up their profile via the
 * service-role client, and reject if the token's `iat` is older than
 * the user's current `session_iat` (i.e. they signed in elsewhere
 * after this token was minted).
 *
 * Returns the service-role `admin` client alongside the user so call
 * sites that already need both don't pay for a second lookup.
 *
 * On any failure returns `{ error: NextResponse }`; otherwise returns
 * the successful auth payload. Always 401 on auth failure (never 500),
 * even for transient lookup errors — exposing detailed server-error
 * info to anonymous callers is the wrong default.
 */
export async function requireAuthenticated(req: Request): Promise<AuthResult> {
  const token = getBearer(req);
  if (!token) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const admin = supabaseAdmin();

  // Single-session check: only enforce when both the token has an `iat`
  // AND the profile row carries `session_iat`. Older accounts won't
  // have session_iat set until they sign in once after the migration.
  const iat = decodeIat(token);
  const { data: prof } = await admin
    .from("profiles")
    .select("session_iat")
    .eq("id", user.id)
    .maybeSingle();

  const sessionIat: number | null = (prof?.session_iat as number | null) ?? null;
  if (sessionIat != null && iat != null && iat < sessionIat) {
    return {
      error: NextResponse.json(
        { error: "session_superseded" },
        { status: 401 },
      ),
    };
  }

  return { user, admin, sb, token, sessionIat };
}

/**
 * Same as `requireAuthenticated` plus a hard check that the resolved
 * user has `profiles.platform_admin = true`. Returns 403 (not 401) on
 * authenticated-but-not-admin so legitimate users with stale roles get
 * a clear signal.
 */
export async function requirePlatformAdmin(
  req: Request,
): Promise<PlatformAdminResult> {
  const base = await requireAuthenticated(req);
  if ("error" in base) return base;

  const { data: me } = await base.admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", base.user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ...base, platformAdmin: true };
}
