import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/student/share/[id]
 *
 * DELETE — revoke a share link. Sets revoked_at to NOW(); the public
 * /share/[token] page will then refuse to render. Soft-delete (we keep
 * the row for audit) rather than physical delete.
 *
 * RLS limits modifications to the link's owner.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: RouteContext) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const { error } = await sb
      .from("student_share_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Revoke failed" },
      { status: 500 },
    );
  }
}
