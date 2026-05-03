import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/admin/schools/[id]
 *
 * Hard-deletes a school. FK cascade behaviour (set in schema):
 *   - profiles.school_id → SET NULL  (members keep their accounts; just unlinked)
 *   - classes.school_id  → CASCADE   (classes + class_members + class_teachers gone)
 *   - subscriptions.school_id → CASCADE (school sub row gone)
 *
 * Auth: platform_admin only.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!prof?.platform_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const admin = supabaseAdmin();

    // Find the school's super_teacher(s) BEFORE the school row goes away
    // (FK on profiles.school_id is SET NULL, so after the cascade we'd
    // have no way to identify them). We delete those auth users too so
    // the platform admin can re-onboard the same email later — otherwise
    // /api/admin/onboard-school's "email already exists" guard rejects.
    const { data: heads } = await admin
      .from("profiles")
      .select("id, role, school_id")
      .eq("school_id", id)
      .eq("role", "super_teacher");

    const { error } = await admin.from("schools").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Delete the super_teacher auth users (their profile row was already
    // unlinked via SET NULL cascade; we now drop the auth account itself).
    // Best-effort: any failure here is logged but doesn't fail the school
    // delete, which already succeeded.
    for (const h of heads || []) {
      try {
        await admin.auth.admin.deleteUser(h.id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[delete school] failed to remove super_teacher auth user", h.id, e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
