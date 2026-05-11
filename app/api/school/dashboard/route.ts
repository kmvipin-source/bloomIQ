import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateQuizCode } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/school/dashboard
 *
 * Bundles every read the /school home page needs into a single
 * service-role call. The previous home-page implementation hit
 * schools, profiles, class_teachers, class_members, quiz_attempts,
 * quizzes, quiz_assignments via the user-token client on first paint
 * — the same RLS race the rest of the codebase has been routing
 * around since migration 49. Centralising the reads here removes the
 * race AND fixes a per-class attempt count bug (used to count every
 * school student against every class rather than that class's actual
 * members).
 *
 * Auth: bearer token required. Caller must be a member of a school
 * (profiles.school_id present). super_teachers and teachers both
 * allowed — the page already differentiates Head vs deputy via the
 * returned caller_is_head flag.
 */

type TeacherRow = {
  id: string;
  full_name: string | null;
  classCount: number;
  quizCount: number;
  assignmentCount: number;
};

type ClassRow = {
  id: string;
  name: string;
  primaryName: string | null;
  memberCount: number;
  attemptCount: number;
  avgScore: number | null;
};

type SchoolRow = {
  id: string;
  name: string;
  super_teacher_id: string | null;
  join_code: string | null;
  logo_url: string | null;
  created_at?: string;
};

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = supabaseAdmin();
    const { data: meProf } = await admin
      .from("profiles")
      .select("school_id, role")
      .eq("id", user.id)
      .maybeSingle();
    const schoolId = (meProf as { school_id?: string | null } | null)?.school_id;
    if (!schoolId) {
      return NextResponse.json({ ok: true, needs_setup: true });
    }

    // School row + join_code self-heal (with retry on unique violation).
    let { data: schoolRaw } = await admin
      .from("schools")
      .select("id, name, super_teacher_id, join_code, logo_url, created_at")
      .eq("id", schoolId)
      .single();
    let school = schoolRaw as SchoolRow | null;
    if (school && !school.join_code) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = generateQuizCode();
        const { data: updated, error: upErr } = await admin
          .from("schools")
          .update({ join_code: candidate })
          .eq("id", school.id)
          .select()
          .single();
        if (!upErr) { school = updated as SchoolRow; break; }
        if ((upErr as { code?: string }).code !== "23505") break;
      }
    }

    // Roster
    const { data: membersRaw } = await admin
      .from("profiles")
      .select("id, role, full_name")
      .eq("school_id", schoolId);
    type Member = { id: string; role: string; full_name: string | null };
    const memberList = (membersRaw as Member[] | null) || [];
    const teacherMembers = memberList.filter(
      (m) => m.role === "teacher" || m.role === "super_teacher"
    );
    const studentMembers = memberList.filter((m) => m.role === "student");
    const teacherIds = teacherMembers.map((t) => t.id);

    // Teacher stats — single batched read per dimension, no N+1.
    const [classTeacherRows, ownedQuizRows] = await Promise.all([
      teacherIds.length === 0
        ? Promise.resolve({ data: [] as Array<{ teacher_id: string; class_id: string }> })
        : admin.from("class_teachers").select("teacher_id, class_id").in("teacher_id", teacherIds),
      teacherIds.length === 0
        ? Promise.resolve({ data: [] as Array<{ id: string; owner_id: string }> })
        : admin.from("quizzes").select("id, owner_id").in("owner_id", teacherIds),
    ]);
    const ctList = (classTeacherRows.data as Array<{ teacher_id: string; class_id: string }> | null) || [];
    const quizList = (ownedQuizRows.data as Array<{ id: string; owner_id: string }> | null) || [];
    const allQuizIds = quizList.map((q) => q.id);

    const { data: asgRows } = allQuizIds.length === 0
      ? { data: [] as Array<{ quiz_id: string }> }
      : await admin.from("quiz_assignments").select("quiz_id").in("quiz_id", allQuizIds);
    const asgByQuiz = new Map<string, number>();
    for (const row of (asgRows as Array<{ quiz_id: string }> | null) || []) {
      asgByQuiz.set(row.quiz_id, (asgByQuiz.get(row.quiz_id) || 0) + 1);
    }

    const teacherStats: TeacherRow[] = teacherMembers.map((t) => {
      const classCount = ctList.filter((c) => c.teacher_id === t.id).length;
      const teacherQuizIds = quizList.filter((q) => q.owner_id === t.id).map((q) => q.id);
      const assignmentCount = teacherQuizIds.reduce(
        (sum, qid) => sum + (asgByQuiz.get(qid) || 0),
        0
      );
      return {
        id: t.id,
        full_name: t.full_name,
        classCount,
        quizCount: teacherQuizIds.length,
        assignmentCount,
      };
    });
    teacherStats.sort((a, b) => (b.quizCount + b.classCount) - (a.quizCount + a.classCount));

    // Classes
    const { data: classRaw } = await admin
      .from("classes")
      .select("id, name, owner_id")
      .eq("school_id", schoolId);
    type Cs = { id: string; name: string; owner_id: string | null };
    const classList = (classRaw as Cs[] | null) || [];
    const classIds = classList.map((c) => c.id);

    // Class members in one read so we can derive both school student
    // count per class AND the correct attempt scope per class (the
    // previous home page used the full school's student set against
    // every class, inflating attemptCount).
    const { data: cmRows } = classIds.length === 0
      ? { data: [] as Array<{ class_id: string; student_id: string }> }
      : await admin.from("class_members").select("class_id, student_id").in("class_id", classIds);
    const membersByClass = new Map<string, string[]>();
    for (const row of (cmRows as Array<{ class_id: string; student_id: string }> | null) || []) {
      const list = membersByClass.get(row.class_id) || [];
      list.push(row.student_id);
      membersByClass.set(row.class_id, list);
    }

    // Primary teacher per class.
    const { data: primaryRows } = classIds.length === 0
      ? { data: [] as Array<{ class_id: string; teacher_id: string }> }
      : await admin
          .from("class_teachers")
          .select("class_id, teacher_id")
          .in("class_id", classIds)
          .eq("role", "primary");
    const primaryByClass = new Map<string, string>();
    for (const row of (primaryRows as Array<{ class_id: string; teacher_id: string }> | null) || []) {
      primaryByClass.set(row.class_id, row.teacher_id);
    }

    // Resolve quiz ids assigned to each class.
    const { data: classQuizAsg } = classIds.length === 0
      ? { data: [] as Array<{ class_id: string; quiz_id: string }> }
      : await admin
          .from("quiz_assignments")
          .select("class_id, quiz_id")
          .in("class_id", classIds);
    const quizIdsByClass = new Map<string, string[]>();
    for (const row of (classQuizAsg as Array<{ class_id: string; quiz_id: string }> | null) || []) {
      const list = quizIdsByClass.get(row.class_id) || [];
      list.push(row.quiz_id);
      quizIdsByClass.set(row.class_id, list);
    }

    const classRows: ClassRow[] = await Promise.all(
      classList.map(async (c) => {
        const memberIds = membersByClass.get(c.id) || [];
        const quizIds = quizIdsByClass.get(c.id) || [];
        const primaryId = primaryByClass.get(c.id);
        const primaryName = primaryId
          ? (teacherMembers.find((t) => t.id === primaryId)?.full_name ||
             (c.owner_id ? teacherMembers.find((t) => t.id === c.owner_id)?.full_name : null) ||
             null)
          : (c.owner_id ? teacherMembers.find((t) => t.id === c.owner_id)?.full_name || null : null);

        let attemptCount = 0;
        let avgScore: number | null = null;
        if (memberIds.length > 0 && quizIds.length > 0) {
          const { data: atts } = await admin
            .from("quiz_attempts")
            .select("score, total")
            .in("student_id", memberIds)
            .in("quiz_id", quizIds)
            .not("submitted_at", "is", null);
          const arr = (atts as Array<{ score: number; total: number }> | null) || [];
          const ratios = arr.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
          attemptCount = ratios.length;
          avgScore = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null;
        }
        return {
          id: c.id,
          name: c.name,
          primaryName,
          memberCount: memberIds.length,
          attemptCount,
          avgScore,
        };
      })
    );
    classRows.sort((a, b) => b.memberCount - a.memberCount);

    // School-wide rollup.
    let attCount = 0;
    let avgScore = 0;
    const studentIds = studentMembers.map((s) => s.id);
    if (studentIds.length > 0) {
      const schoolClassQuizIds = Array.from(
        new Set<string>([...quizIdsByClass.values()].flat())
      );
      if (schoolClassQuizIds.length > 0) {
        const { data: att, count } = await admin
          .from("quiz_attempts")
          .select("score, total", { count: "exact" })
          .in("student_id", studentIds)
          .in("quiz_id", schoolClassQuizIds)
          .not("submitted_at", "is", null);
        const arr = (att as Array<{ score: number; total: number }> | null) || [];
        attCount = count || 0;
        const ratios = arr.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
        avgScore = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : 0;
      }
    }
    const totalQuizzes = teacherStats.reduce((s, t) => s + t.quizCount, 0);

    return NextResponse.json({
      ok: true,
      needs_setup: false,
      caller_is_head: school?.super_teacher_id === user.id,
      school,
      teachers: teacherStats,
      classes: classRows,
      stats: {
        teachers: teacherMembers.length,
        classes: classRows.length,
        students: studentMembers.length,
        quizzes: totalQuizzes,
        attempts: attCount,
        avgScore,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
