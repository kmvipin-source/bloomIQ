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
    // Defense-in-depth: scope the UPDATE explicitly by user_id even
    // though RLS should already enforce this. A policy regression
    // (or a future role with broader UPDATE rights) would otherwise
    // let any authenticated user revoke an arbitrary share link by
    // id. The .select() ensures we get back the row we updated, so
    // we can surface a 404 if it didn't exist or wasn't ours.
    const { data: updated, error } = await sb
      .from("student_share_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!updated) {
      return NextResponse.json({ error: "Share link not found." }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Revoke failed" },
      { status: 500 },
    );
  }
}
