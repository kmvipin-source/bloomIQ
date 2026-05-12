import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/super-teachers/[id]/reset-password
 *
 * Platform-admin support tool: set a super_teacher's password to a known
 * value when they've forgotten theirs and the BloomIQ team needs to get
 * them back in fast. Mirrors the teacher-resets-student flow at
 * /api/admin/students/[id]/reset-password.
 *
 * Body: { password: string }   // min 6 chars
 *
 * Auth: caller must have profiles.platform_admin = true.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id: targetId } = await params;
    const body = await req.json().catch(() => ({}));
    const password: string = String(body.password || "");
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    // Verify the target is actually a super_teacher (don't accidentally
    // let this endpoint reset a platform admin or a regular student).
    const admin = supabaseAdmin();
    const { data: prof } = await admin
      .from("profiles")
      .select("role, platform_admin")
      .eq("id", targetId)
      .maybeSingle();
    if (!prof) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (prof.role !== "super_teacher") {
      return NextResponse.json(
        { error: "Endpoint reserved for super_teacher accounts" },
        { status: 400 },
      );
    }
    if (prof.platform_admin) {
      return NextResponse.json(
        { error: "Cannot reset a platform admin via this endpoint" },
        { status: 400 },
      );
    }

    const { error } = await admin.auth.admin.updateUserById(targetId, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await admin.auth.admin.signOut(targetId).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reset failed" },
      { status: 500 },
    );
  }
}
