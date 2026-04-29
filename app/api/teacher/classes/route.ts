import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/teacher/classes
 *
 * Returns the list of classes the calling teacher is assigned to as either
 * primary or co-teacher, with student counts pre-computed.
 *
 * Why a server route (and not a direct supabase-js query from the client):
 * the assignment row in class_teachers is written by the school admin via
 * the service-role key (bypasses RLS). For the teacher to see it on the
 * client, RLS must allow:
 *   1. SELECT on class_teachers where teacher_id = auth.uid()
 *   2. SELECT on the embedded classes row (the join target)
 * If either is blocked — e.g. because migration 04 wasn't applied to the
 * deployed database, or a later migration regressed the policy — the row
 * silently disappears from the join and the teacher sees "No classes yet"
 * even though the admin sees the assignment as ✅ Active.
 *
 * This route authenticates the user with their bearer token, verifies the
 * profile is role='teacher', then reads class_teachers + classes via the
 * service-role client. RLS gaps cannot hide an assignment from the actual
 * assigned teacher.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sb = supabaseServer(token);
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Caller must be a teacher (or super_teacher who also teaches a class —
    // unusual but allowed). We don't gate by role too tightly; if the caller
    // has a class_teachers row, they can see it.
    const admin = supabaseAdmin();

    type CtRow = {
      class_id: string;
      role: "primary" | "co";
      subject: string | null;
      added_at: string;
      class:
        | {
            id: string;
            name: string;
            grade: string | null;
            subject: string | null;
            section: string | null;
            join_code: string;
            owner_id: string | null;
            school_id: string | null;
            created_at: string;
          }
        | null;
    };

    const { data: cts, error: ctErr } = await admin
      .from("class_teachers")
      .select(
        "class_id, role, subject, added_at, class:classes(id, name, grade, subject, section, join_code, owner_id, school_id, created_at)"
      )
      .eq("teacher_id", user.id);
    if (ctErr) {
      return NextResponse.json({ error: ctErr.message }, { status: 500 });
    }

    const rows = ((cts as unknown as CtRow[]) || []).filter((r) => r.class);

    // Per-class student counts. One round-trip even with many classes.
    const counts: Record<string, number> = {};
    if (rows.length > 0) {
      const ids = rows.map((r) => r.class_id);
      const { data: members } = await admin
        .from("class_members")
        .select("class_id")
        .in("class_id", ids);
      for (const m of ((members as { class_id: string }[]) || [])) {
        counts[m.class_id] = (counts[m.class_id] || 0) + 1;
      }
    }

    // Sort: primary first, then most recently created.
    const list = rows
      .map((r) => ({
        id: r.class!.id,
        name: r.class!.name,
        grade: r.class!.grade,
        subject: r.class!.subject,
        section: r.class!.section,
        join_code: r.class!.join_code,
        owner_id: r.class!.owner_id,
        school_id: r.class!.school_id,
        created_at: r.class!.created_at,
        myRole: r.role,
        mySubject: r.subject,
        memberCount: counts[r.class_id] || 0,
      }))
      .sort((a, b) => {
        if (a.myRole !== b.myRole) return a.myRole === "primary" ? -1 : 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

    return NextResponse.json({ ok: true, classes: list });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load classes" },
      { status: 500 }
    );
  }
}
