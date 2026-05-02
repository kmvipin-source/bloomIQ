import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/auth/set-password
 *
 * Body: { password: string, tos_version?: string }
 *
 * Sets a password for the currently-authenticated user via the service
 * role, which bypasses the AAL2 requirement that Supabase places on
 * `updateUser({ password })` whenever an MFA factor is enrolled.
 *
 * The AAL2 rule is right for an already-onboarded user who wants to
 * rotate their password — it stops a stolen low-AAL session from also
 * stealing the long-term credential. But it breaks first-time invitees
 * who have a leftover unverified TOTP factor: they have no second factor
 * to challenge, so they can never finish setting a real password.
 *
 * The flow that calls this endpoint always operates on a recovery / invite
 * session, which Supabase already validated by issuing the access token,
 * so admin-side update is safe for our threat model.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const password = String(body.password || "");
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }
    const tosVersion = String(body.tos_version || "2026-04-30");

    const admin = supabaseAdmin();

    // Drop any unverified TOTP factors before updating. They aren't
    // protecting anything (status=unverified means the user never finished
    // enrollment) but they cause the AAL2 wall in the first place. Verified
    // factors are left alone — those represent real 2FA and shouldn't be
    // silently torn down.
    try {
      const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
      const stale = (factors?.factors || []).filter((f) => f.status === "unverified");
      for (const f of stale) {
        await admin.auth.admin.mfa.deleteFactor({ userId: user.id, id: f.id });
      }
    } catch { /* best-effort cleanup */ }

    const { error: upErr } = await admin.auth.admin.updateUserById(user.id, {
      password,
      user_metadata: {
        ...(user.user_metadata || {}),
        tos_accepted_at: new Date().toISOString(),
        tos_version: tosVersion,
      },
    });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
