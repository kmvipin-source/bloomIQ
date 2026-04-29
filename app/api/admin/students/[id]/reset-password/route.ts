import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: studentId } = await params;
    const body = await req.json().catch(() => ({}));
    const password: string = String(body.password || "");
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    // Authorize: requester must own a class containing the student
    const { data: ownership } = await sb
      .from("class_members")
      .select("class_id, classes!inner(owner_id)")
      .eq("student_id", studentId);

    type OwnerRow = { class_id: string; classes: { owner_id: string } };
    const owns = ((ownership as unknown as OwnerRow[]) || []).some(
      (r) => r.classes?.owner_id === user.id
    );
    if (!owns) return NextResponse.json({ error: "Not authorised for this student" }, { status: 403 });

    // Reset password + globally sign out (kicks off any active sessions)
    const admin = supabaseAdmin();
    const { error } = await admin.auth.admin.updateUserById(studentId, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Best-effort: invalidate any current refresh tokens so old logins die
    await admin.auth.admin.signOut(studentId).catch(() => {});

    // Audit
    await admin.from("student_password_resets").insert({
      student_id: studentId,
      reset_by: user.id,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Reset failed" }, { status: 500 });
  }
}
