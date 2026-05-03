import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * Returns the caller's role + platform_admin + is_school_student
 * by reading profiles via the service-role client. The user-token
 * supabase-js client occasionally fails to read profiles from the
 * Vercel edge (RLS race), which broke the /login role-tab gate for
 * legitimate users. This endpoint fixes that by establishing identity
 * via sb.auth.getUser() (bearer token) and looking up the profile
 * with admin privileges.
 *
 * Caller must pass the bearer access token in the Authorization
 * header. Returns 401 if the token doesn't resolve to a user.
 */
function decodeIat(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as { iat?: number };
    return typeof obj.iat === "number" ? obj.iat : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = supabaseAdmin();
    const { data: prof } = await admin
      .from("profiles")
      .select("role, is_school_student, platform_admin, school_id, session_iat")
      .eq("id", user.id)
      .maybeSingle();

    // Single-session enforcement: reject if this JWT was issued before
    // the user's most recently claimed session (i.e. they signed in
    // somewhere else after this token was minted).
    const iat = decodeIat(token);
    if (prof?.session_iat && iat && iat < prof.session_iat) {
      return NextResponse.json({ error: "session_superseded" }, { status: 401 });
    }

    const metaRole = String((user.user_metadata as { role?: string } | undefined)?.role || "");
    return NextResponse.json({
      ok: true,
      uid: user.id,
      email: user.email || null,
      role: prof?.role || metaRole || null,
      is_school_student: !!prof?.is_school_student,
      platform_admin: !!prof?.platform_admin,
      school_id: prof?.school_id || null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
