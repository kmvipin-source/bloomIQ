import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { loadClassQuizIdsForClasses } from "@/lib/studentScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/school/reports?days=<7|30|90|365|all>
 *
 * Bundles every read the /school/reports page needs into a single
 * service-role call. The previous implementation pulled profiles,
 * schools, classes, class_members, quiz_attempts, attempt_answers,
 * quiz_assignments, quizzes, question_bank, live_sessions via the
 * user-token client and raced RLS on first paint for some Heads,
 * dropping rows that the official report can't afford to lose.
 *
 * Also: teacherList now includes super_teacher rows so a Head or
 * Deputy who teaches a class contributes to the Teacher Activity /
 * Bloom Contribution tables. The previous page hard-filtered on
 * role='teacher' and silently excluded their work.
 *
 * Auth: bearer token required. Caller must be a super_teacher with
 * an attached school.
 */
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
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!meProf || meProf.role !== "super_teacher" || !meProf.school_id) {
      return NextResponse.json({ error: "Only school admins can view reports." }, { status: 403 });
    }
    const schoolId = meProf.school_id as string;

    const url = new URL(req.url);
    const daysRaw = url.searchParams.get("days") || "30";
    const daysNum = daysRaw === "all" ? null : Math.max(1, Math.min(365, parseInt(daysRaw, 10) || 30));
    const since = daysNum ? new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString() : null;

    const { data: school } = await admin
      .from("schools")
      .select("id, name")
      .eq("id", schoolId)
      .maybeSingle();

    // Profiles in this school. Teachers list now includes super_teacher
    // members so a primary-teaching Head/Deputy shows up in the
    // Teacher Activity + Bloom Contribution rollups.
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name, role")
      .eq("school_id", schoolId);
    type Profile = { id: string; full_name: string | null; role: string };
    const profList = (profiles as Profile[] | null) || [];
    const teacherList = profList.filter((p) => p.role === "teacher" || p.role === "super_teacher");
    const studentList = profList.filter((p) => p.role === "student");

    const { data: cs } = await admin
      .from("classes")
      .select("id, name, grade, owner_id")
      .eq("school_id", schoolId);
    type Cls = { id: string; name: string; grade: string | null; owner_id: string | null };
    const classList = (cs as Cls[] | null) || [];
    const classIds = classList.map((c) => c.id);

    if (classIds.length === 0) {
      return NextResponse.json({
        ok: true,
        school,
        teachers: teacherList,
        students: studentList,
        classes: classList,
        members: [],
        attempts: [],
        answers: [],
        assignments: [],
        quizzesMeta: [],
        questionsMeta: [],
        liveCountsByTeacher: {},
      });
    }

    const { data: ms } = await admin
      .from("class_members")
      .select("class_id, student_id")
      .in("class_id", classIds);
    type Member = { class_id: string; student_id: string };
    const members = (ms as Member[] | null) || [];

    const studentIds = studentList.map((s) => s.id);
    if (studentIds.length === 0) {
      return NextResponse.json({
        ok: true,
        school,
        teachers: teacherList,
        students: studentList,
        classes: classList,
        members,
        attempts: [],
        answers: [],
        assignments: [],
        quizzesMeta: [],
        questionsMeta: [],
        liveCountsByTeacher: {},
      });
    }

    const classQuizIds = await loadClassQuizIdsForClasses(admin, classIds);
    const classQuizIdArr = Array.from(classQuizIds);
    if (classQuizIdArr.length === 0) {
      return NextResponse.json({
        ok: true,
        school,
        teachers: teacherList,
        students: studentList,
        classes: classList,
        members,
        attempts: [],
        answers: [],
        assignments: [],
        quizzesMeta: [],
        questionsMeta: [],
        liveCountsByTeacher: {},
      });
    }

    let attemptsQ = admin
      .from("quiz_attempts")
      .select("id, student_id, quiz_id, score, total, submitted_at")
      .in("student_id", studentIds)
      .in("quiz_id", classQuizIdArr)
      .not("submitted_at", "is", null);
    if (since) attemptsQ = attemptsQ.gte("submitted_at", since);
    const { data: atts } = await attemptsQ;
    type Att = { id: string; student_id: string; quiz_id: string; score: number; total: number; submitted_at: string };
    const attList = (atts as Att[] | null) || [];

    let answers: Array<{ attempt_id: string; question_id: string; bloom_level: string; is_correct: boolean }> = [];
    if (attList.length > 0) {
      const attemptIds = attList.map((a) => a.id);
      const { data: ans } = await admin
        .from("attempt_answers")
        .select("attempt_id, question_id, bloom_level, is_correct")
        .in("attempt_id", attemptIds);
      answers = (ans as typeof answers) || [];
    }

    const teacherIds = teacherList.map((t) => t.id);
    const [asgRes, quizRes, qbRes, liveRes] = await Promise.all([
      admin.from("quiz_assignments").select("quiz_id, class_id, student_id").in("class_id", classIds),
      admin.from("quizzes").select("id, name, subject, owner_id, created_at").in("id", classQuizIdArr),
      (async () => {
        const qids = Array.from(new Set(answers.map((a) => a.question_id).filter(Boolean)));
        if (qids.length === 0) return { data: [] as Array<{ id: string; topic_family: string | null; bloom_level: string | null; owner_id: string | null }> };
        return admin.from("question_bank").select("id, topic_family, bloom_level, owner_id").in("id", qids);
      })(),
      teacherIds.length === 0
        ? Promise.resolve({ data: [] as Array<{ host_teacher_id: string }> })
        : admin.from("live_sessions").select("host_teacher_id").in("host_teacher_id", teacherIds),
    ]);

    const liveCounts: Record<string, number> = {};
    for (const r of ((liveRes.data as Array<{ host_teacher_id: string }>) || [])) {
      liveCounts[r.host_teacher_id] = (liveCounts[r.host_teacher_id] || 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      school,
      teachers: teacherList,
      students: studentList,
      classes: classList,
      members,
      attempts: attList,
      answers,
      assignments: (asgRes.data as Array<{ quiz_id: string; class_id: string; student_id: string | null }>) || [],
      quizzesMeta: (quizRes.data as Array<{ id: string; name: string; subject: string | null; owner_id: string | null; created_at: string }>) || [],
      questionsMeta: (qbRes.data as Array<{ id: string; topic_family: string | null; bloom_level: string | null; owner_id: string | null }>) || [],
      liveCountsByTeacher: liveCounts,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
