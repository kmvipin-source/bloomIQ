import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/admin/classes/[id]/status
 *
 * Soft-delete a class (deactivate) or reactivate one. Body shape:
 *
 *   { status: "inactive" }   -> deactivate
 *   { status: "active"   }   -> reactivate
 *
 * Auth: school Admin Head only (super_teacher of the class's school).
 * Co-teachers and even the primary teacher cannot deactivate a class —
 * this is an organisation-level action that needs Admin Head sign-off.
 *
 * Effect (deactivate):
 *   - classes.status        -> 'inactive'
 *   - classes.deactivated_at-> now()
 *   - classes.deactivated_by-> caller user id
 *   - All historical rows (attempts, assignments, retake requests,
 *     class_teachers, invites) STAY in place. Reactivation restores
 *     full functionality with zero data loss.
 *
 * Effect (reactivate):
 *   - classes.status        -> 'active'
 *   - classes.deactivated_at-> NULL
 *   - classes.deactivated_by-> NULL
 *
 * Migration 78 introduced the columns. Returns the new status + timestamp
 * so the client can update the UI without a second round-trip.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { id: classId } = await params;
    if (!classId) return NextResponse.json({ error: "Missing class id" }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const wantedStatus = String(body?.status || "").toLowerCase().trim();
    if (wantedStatus !== "active" && wantedStatus !== "inactive") {
      return NextResponse.json(
        { error: "status must be 'active' or 'inactive'" },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    // Authorise: must be Admin Head of THIS class's school. We look up
    // the class first to discover its school, then check the caller.
    const { data: cls } = await admin
      .from("classes")
      .select("id, school_id, name, status")
      .eq("id", classId)
      .maybeSingle();
    if (!cls) return NextResponse.json({ error: "Class not found." }, { status: 404 });

    const { data: me } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    const isAdminOfSchool =
      me?.role === "super_teacher" && me.school_id === (cls as { school_id: string }).school_id;
    if (!isAdminOfSchool) {
      return NextResponse.json(
        { error: "Only the school Admin Head can deactivate or reactivate a class." },
        { status: 403 }
      );
    }

    // Idempotent: if the class is already in the requested state, return
    // the existing row instead of writing a no-op update + new audit timestamp.
    const currentStatus = (cls as { status?: string }).status || "active";
    if (currentStatus === wantedStatus) {
      return NextResponse.json({
        ok: true,
        status: wantedStatus,
        changed: false,
        message: `Class is already ${wantedStatus}.`,
      });
    }

    const patch: Record<string, unknown> =
      wantedStatus === "inactive"
        ? {
            status: "inactive",
            deactivated_at: new Date().toISOString(),
            deactivated_by: user.id,
          }
        : {
            status: "active",
            deactivated_at: null,
            deactivated_by: null,
          };

    const { error: upErr } = await admin
      .from("classes")
      .update(patch)
      .eq("id", classId);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      status: wantedStatus,
      changed: true,
      class_id: classId,
      class_name: (cls as { name?: string }).name ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to change class status" },
      { status: 500 }
    );
  }
}
