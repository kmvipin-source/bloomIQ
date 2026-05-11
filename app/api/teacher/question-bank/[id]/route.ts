import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * DELETE /api/teacher/question-bank/[id]
 *
 * Deletes the caller's own question_bank row via the service role. The
 * /teacher/quizzes/new page used to hit question_bank directly with the
 * user-token client, which raced RLS the same way the GET path did. The
 * companion GET route already exists; this is the matching write path.
 *
 * Caller identity is verified via supabaseServer(token).auth.getUser().
 * The service-role delete is gated on owner_id = caller, so it never
 * widens write access beyond what the RLS policy already grants.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing question id" }, { status: 400 });

    const admin = supabaseAdmin();
    const { error } = await admin
      .from("question_bank")
      .delete()
      .eq("id", id)
      .eq("owner_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 }
    );
  }
}
