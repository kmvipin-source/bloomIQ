import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/teacher/invites
 *
 * Lists all pending class_teacher_invites whose email matches the caller.
 * Joins class + school metadata via the admin client so the teacher gets
 * a readable inbox even when their RLS doesn't independently expose
 * those classes (which is exactly the case before they accept).
 */
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;
    const email = (user.email || "").toLowerCase();
    if (!email) return NextResponse.json({ ok: true, invites: [] });

    const admin = supabaseAdmin();
    const { data: rows } = await admin
      .from("class_teacher_invites")
      .select("class_id, role, subject, invited_at, invited_by")
      .eq("email", email)
      .eq("status", "pending");

    if (!rows?.length) return NextResponse.json({ ok: true, invites: [] });

    const classIds = rows.map((r) => r.class_id);
    const { data: classes } = await admin
      .from("classes")
      .select("id, name, school_id")
      .in("id", classIds)
      .eq("status", "active");
    const cMap = new Map((classes || []).map((c) => [c.id as string, c]));

    const schoolIds = Array.from(new Set((classes || []).map((c) => c.school_id).filter(Boolean) as string[]));
    const { data: schools } = schoolIds.length
      ? await admin.from("schools").select("id, name").in("id", schoolIds)
      : { data: [] as { id: string; name: string }[] };
    const sMap = new Map((schools || []).map((s) => [s.id as string, s.name as string]));

    const inviterIds = Array.from(new Set(rows.map((r) => r.invited_by).filter(Boolean) as string[]));
    const { data: inviters } = inviterIds.length
      ? await admin.from("profiles").select("id, full_name").in("id", inviterIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const iMap = new Map((inviters || []).map((p) => [p.id as string, p.full_name as string | null]));

    const invites = rows.map((r) => {
      const cls = cMap.get(r.class_id);
      return {
        class_id: r.class_id,
        class_name: cls?.name || "—",
        school_id: cls?.school_id || null,
        school_name: cls?.school_id ? (sMap.get(cls.school_id) || "—") : "—",
        role: r.role,
        subject: r.subject,
        invited_at: r.invited_at,
        invited_by_name: r.invited_by ? (iMap.get(r.invited_by) || "your school admin") : "your school admin",
      };
    });
    return NextResponse.json({ ok: true, invites });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
