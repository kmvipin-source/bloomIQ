import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { evaluatePublicFlags } from "@/lib/featureFlags";

export const runtime = "nodejs";
// Tiny TTL so the browser respects fresh values when the admin flips a
// flag, but doesn't hammer us on every page transition.
export const dynamic = "force-dynamic";

/**
 * GET /api/flags/public
 *
 * Returns the subset of platform flags marked publicReadable in the
 * registry, evaluated for the calling user's context (their userId
 * and, if available, their school_id). Anonymous callers get the
 * global-default evaluation. Never leaks the pilot allowlist.
 *
 * Shape:
 *   { flags: { school_marketing_visible: bool, school_signup_enabled: bool, ... } }
 */
export async function GET(req: Request) {
  let userId: string | null = null;
  let schoolId: string | null = null;

  const token = getBearer(req);
  if (token) {
    try {
      const sb = supabaseServer(token);
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        userId = user.id;
        // Look up school via service role so RLS can't accidentally
        // hide it (the school_id is needed to know whether a pilot
        // override applies — it's not user-secret either way).
        const admin = supabaseAdmin();
        const { data: prof } = await admin
          .from("profiles")
          .select("school_id")
          .eq("id", user.id)
          .maybeSingle();
        schoolId = prof?.school_id || null;
      }
    } catch {
      // Token bad / DB hiccup — treat as anonymous. The flag layer
      // already has its own DB-outage fallback below.
    }
  }

  const flags = await evaluatePublicFlags({ userId, schoolId });
  return NextResponse.json(
    { flags },
    {
      headers: {
        // F7 fix: boolean context hints only — never leak the user/school
        // UUIDs in response headers (they survive CSP and are visible to
        // any JS on the page).
        "x-flags-context-authed": userId ? "1" : "0",
        "x-flags-context-school": schoolId ? "1" : "0",
        // F10 fix: drop the 30s browser cache so admin flips propagate
        // sooner. Server-side 60s TTL in lib/featureFlags.ts still
        "Cache-Control": "private, no-store",
      },
    }
  );
}
