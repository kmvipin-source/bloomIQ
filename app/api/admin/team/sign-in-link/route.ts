import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/team/sign-in-link
 *
 * Generates a fresh single-use sign-in URL for an existing admin. Used
 * when:
 *   - an admin is in "confirmed-but-no-working-password" zombie state
 *     (e.g., from the old broken invite flow), so the original grant
 *     didn't return a link
 *   - the admin forgot their password
 *   - the granting admin just wants to give them a fresh way in
 *
 * The URL:
 *   - is single-use (Supabase invalidates it after first click)
 *   - expires per Supabase project settings (~1 hour default)
 *   - drops them on /auth/set-password where they choose their own
 *     password — the granting admin never sees it
 *
 * Body: { user_id: string }
 *
 * Authorization: caller must be a platform_admin themselves. We don't
 * impose extra restrictions on which admin you can re-link — any admin
 * can re-link any other admin. This is intentional: the alternative
 * (an admin losing access with no other admin to help them) is worse.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .single();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const userId: string = String(body.user_id || "").trim();
    if (!userId) {
      return NextResponse.json({ error: "user_id is required" }, { status: 400 });
    }

    const admin = supabaseAdmin();

    // Look up the target user so we know their email + verify they're
    // actually a platform admin (we don't want to re-link arbitrary
    // people from this endpoint — only existing admins).
    const { data: targetProf } = await admin
      .from("profiles")
      .select("id, platform_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!targetProf?.platform_admin) {
      return NextResponse.json(
        { error: "That user is not a platform admin." },
        { status: 400 }
      );
    }

    const { data: targetAuth, error: getErr } = await admin.auth.admin.getUserById(userId);
    if (getErr || !targetAuth?.user?.email) {
      return NextResponse.json(
        { error: `Could not find auth user: ${getErr?.message || "unknown"}` },
        { status: 500 }
      );
    }

    const origin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
      new URL(req.url).origin;
    const redirectTo = `${origin.replace(/\/$/, "")}/auth/set-password?next=/admin/onboard-school`;

    // 'magiclink' is correct for any user that already exists in
    // auth.users — confirmed or not. Supabase doesn't require the user
    // to be confirmed for magiclink to work; the click confirms them
    // if they weren't already.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: targetAuth.user.email,
      options: { redirectTo },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      return NextResponse.json(
        { error: `Could not generate link: ${linkErr?.message || "unknown error"}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      user_id: userId,
      email: targetAuth.user.email,
      sign_in_link: linkData.properties.action_link,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not generate link" },
      { status: 500 }
    );
  }
}
