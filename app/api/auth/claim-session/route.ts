import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
// Finding #17 fix: shared decodeIat (was duplicated locally).
import { decodeIat } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/auth/claim-session
 *
 * Single-session enforcement step. The client calls this immediately
 * after a successful sb.auth.signInWithPassword. The server decodes
 * the new access token, extracts iat (issued-at, seconds since epoch),
 * and writes it to profiles.session_iat for the user. Any older JWT
 * still floating around on a different device will be rejected by
 * /api/auth/me's iat comparison.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const iat = decodeIat(token);
    if (!iat) return NextResponse.json({ error: "Could not decode token" }, { status: 400 });

    const admin = supabaseAdmin();
    const { error } = await admin
      .from("profiles")
      .update({ session_iat: iat })
      .eq("id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, session_iat: iat });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
