// =============================================================================
// lib/schoolContext.ts
// -----------------------------------------------------------------------------
// Server-only helper that builds a compact JSON snapshot of a school's current
// state for the Principal AI Coach + Weekly Brief features. We intentionally
// keep the payload under ~3KB so the LLM has plenty of headroom for its reply.
//
// This crosses teacher-ownership boundaries (we want school-wide aggregates),
// so we use the service-role client (`supabaseAdmin`). Callers MUST verify the
// requesting user is a super_teacher of THIS school before invoking us.
// =============================================================================
import { supabaseAdmin } from "@/lib/supabase/server";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

export type BloomMastery = {
  correct: number;
  total: number;
  pct: number | null;
};

export type SchoolContext = {
  school: { id: string; name: string };
  asOf: string; // ISO timestamp
  totals: {
    teachers: number;
    students: number;
    classes: number;
    quizzes: number;
    attempts_30d: number;
    avg_score_30d: number; // 0-100
  };
  classes: Array<{
    id: string;
    name: string;
    primary_teacher: string | null;
    students: number;
    attempts_30d: number;
    avg_score_30d: number | null;
  }>;
  bloom_mastery_30d: Record<BloomLevel, BloomMastery>;
  top_students: Array<{
    name: string;
    class: string | null;
    avg_pct: number;
    attempts: number;
  }>;
  at_risk: Array<{
    name: string;
    class: string | null;
    signal: "low_score" | "declining" | "inactive";
    detail: string;
  }>;
  engagement: {
    last7_dau: number;
    prior7_dau: number;
    last7_completions: number;
    prior7_completions: number;
  };
};

// === Local row types (admin client returns plain JSON) ====================
type SchoolRow = { id: string; name: string };
type ProfileRow = { id: string; role: string; full_name: string | null };
type ClassRow = { id: string; name: string };
type ClassTeacherRow = { class_id: string; teacher_id: string; role: string };
type ClassMemberRow = { class_id: string; student_id: string };
type AttemptRow = {
  id: string;
  student_id: string;
  score: number;
  total: number;
  submitted_at: string;
};
type AttemptAnswerRow = {
  attempt_id: string;
  bloom_level: string | null;
  is_correct: boolean | null;
};

// Round to whole percent or return null on no-data.
function pct(correct: number, total: number): number | null {
  if (!total || total <= 0) return null;
  return Math.round((correct / total) * 100);
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyBloomMastery(): Record<BloomLevel, BloomMastery> {
  const out = {} as Record<BloomLevel, BloomMastery>;
  for (const lvl of BLOOM_LEVELS) out[lvl] = { correct: 0, total: 0, pct: null };
  return out;
}

export async function buildSchoolContext(schoolId: string): Promise<SchoolContext> {
  const admin = supabaseAdmin();
  const asOf = new Date().toISOString();

  // === School row ========================================================
  const { data: schoolData } = await admin
    .from("schools")
    .select("id, name")
    .eq("id", schoolId)
    .maybeSingle();
  const school: SchoolRow = (schoolData as SchoolRow | null) || {
    id: schoolId,
    name: "Unknown",
  };

  // === Profiles in this school (split by role) ===========================
  const { data: profsData } = await admin
    .from("profiles")
    .select("id, role, full_name")
    .eq("school_id", schoolId);
  const profiles: ProfileRow[] = (profsData as ProfileRow[] | null) || [];
  const teachers = profiles.filter((p) => p.role === "teacher" || p.role === "super_teacher");
  const students = profiles.filter((p) => p.role === "student");
  const profById = new Map<string, ProfileRow>();
  for (const p of profiles) profById.set(p.id, p);
  const studentIds = students.map((s) => s.id);

  // === Classes ===========================================================
  // Filter out soft-deleted classes (migration 78). Inactive classes
  // remain in the DB for audit but must not appear in coach contexts.
  const { data: classesData } = await admin
    .from("classes")
    .select("id, name")
    .eq("school_id", schoolId)
    .eq("status", "active");
  const classes: ClassRow[] = (classesData as ClassRow[] | null) || [];
  const classIds = classes.map((c) => c.id);

  // Primary teacher per class
  let classTeachers: ClassTeacherRow[] = [];
  if (classIds.length > 0) {
    const { data: ctData } = await admin
      .from("class_teachers")
      .select("class_id, teacher_id, role")
      .in("class_id", classIds)
      .eq("role", "primary");
    classTeachers = (ctData as ClassTeacherRow[] | null) || [];
  }
  const primaryByClass = new Map<string, string>(); // class_id -> teacher_id
  for (const ct of classTeachers) primaryByClass.set(ct.class_id, ct.teacher_id);

  // Class members (so we can attribute students to a primary class)
  let classMembers: ClassMemberRow[] = [];
  if (classIds.length > 0) {
    const { data: cmData } = await admin
      .from("class_members")
      .select("class_id, student_id")
      .in("class_id", classIds);
    classMembers = (cmData as ClassMemberRow[] | null) || [];
  }
  // student_id -> first class name (for display only)
  const studentClassName = new Map<string, string>();
  const classNameById = new Map<string, string>();
  for (const c of classes) classNameById.set(c.id, c.name);
  for (const m of classMembers) {
    if (!studentClassName.has(m.student_id)) {
      const name = classNameById.get(m.class_id);
      if (name) studentClassName.set(m.student_id, name);
    }
  }

  // === Quizzes count (school-wide via teacher owners) ====================
  let quizzesCount = 0;
  if (teachers.length > 0) {
    const { count } = await admin
      .from("quizzes")
      .select("id", { count: "exact", head: true })
      .in("owner_id", teachers.map((t) => t.id));
    quizzesCount = count || 0;
  }

  // === Attempts (last 30 days, submitted) ================================
  const now = Date.now();
  const since30 = new Date(now - 30 * 86_400_000).toISOString();
  let attempts30: AttemptRow[] = [];
  if (studentIds.length > 0) {
    const { data: attData } = await admin
      .from("quiz_attempts")
      .select("id, student_id, score, total, submitted_at")
      .in("student_id", studentIds)
      .not("submitted_at", "is", null)
      .gte("submitted_at", since30);
    attempts30 = (attData as AttemptRow[] | null) || [];
  }

  // School-wide avg + count for last 30 days
  const ratios30 = attempts30.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
  const avgScore30 = ratios30.length
    ? Math.round(ratios30.reduce((s, x) => s + x, 0) / ratios30.length)
    : 0;

  // === All-time attempts per student (for top_students + at_risk) ========
  // We want last-3 averages and inactive-day counts, which need broader history.
  let attemptsAll: AttemptRow[] = [];
  if (studentIds.length > 0) {
    const { data: allData } = await admin
      .from("quiz_attempts")
      .select("id, student_id, score, total, submitted_at")
      .in("student_id", studentIds)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(2000);
    attemptsAll = (allData as AttemptRow[] | null) || [];
  }
  const attemptsByStudent = new Map<string, AttemptRow[]>();
  for (const a of attemptsAll) {
    const arr = attemptsByStudent.get(a.student_id) || [];
    arr.push(a);
    attemptsByStudent.set(a.student_id, arr);
  }

  // === Per-class roll-ups for last 30 days ===============================
  const studentToClasses = new Map<string, string[]>(); // student -> [classId]
  for (const m of classMembers) {
    const arr = studentToClasses.get(m.student_id) || [];
    arr.push(m.class_id);
    studentToClasses.set(m.student_id, arr);
  }

  // For per-class aggregates, group attempts30 by each class the student
  // belongs to. (A student in multiple classes contributes to each.)
  type ClassAgg = { ratios: number[]; attempts: number };
  const classAgg = new Map<string, ClassAgg>();
  for (const c of classes) classAgg.set(c.id, { ratios: [], attempts: 0 });
  for (const a of attempts30) {
    const cls = studentToClasses.get(a.student_id) || [];
    for (const cid of cls) {
      const agg = classAgg.get(cid);
      if (!agg) continue;
      agg.attempts += 1;
      if (a.total > 0) agg.ratios.push((a.score / a.total) * 100);
    }
  }
  const classStudentCount = new Map<string, number>();
  for (const c of classes) classStudentCount.set(c.id, 0);
  for (const m of classMembers) {
    classStudentCount.set(m.class_id, (classStudentCount.get(m.class_id) || 0) + 1);
  }

  const classesOut = classes.map((c) => {
    const agg = classAgg.get(c.id) || { ratios: [], attempts: 0 };
    const teacherId = primaryByClass.get(c.id);
    const teacherName = teacherId ? profById.get(teacherId)?.full_name ?? null : null;
    const avg = agg.ratios.length
      ? Math.round(agg.ratios.reduce((s, x) => s + x, 0) / agg.ratios.length)
      : null;
    return {
      id: c.id,
      name: c.name,
      primary_teacher: teacherName,
      students: classStudentCount.get(c.id) || 0,
      attempts_30d: agg.attempts,
      avg_score_30d: avg,
    };
  });

  // === Bloom mastery (last 30 days) ======================================
  const bloom = emptyBloomMastery();
  if (attempts30.length > 0) {
    const attemptIds = attempts30.map((a) => a.id);
    // Chunk to avoid hitting the .in() length limit on very large schools.
    const chunkSize = 500;
    const allAns: AttemptAnswerRow[] = [];
    for (let i = 0; i < attemptIds.length; i += chunkSize) {
      const slice = attemptIds.slice(i, i + chunkSize);
      const { data: ans } = await admin
        .from("attempt_answers")
        .select("attempt_id, bloom_level, is_correct")
        .in("attempt_id", slice);
      if (ans) allAns.push(...(ans as AttemptAnswerRow[]));
    }
    for (const row of allAns) {
      if (!row.bloom_level) continue;
      const lvl = row.bloom_level as BloomLevel;
      if (!(BLOOM_LEVELS as readonly string[]).includes(lvl)) continue;
      bloom[lvl].total += 1;
      if (row.is_correct) bloom[lvl].correct += 1;
    }
    for (const lvl of BLOOM_LEVELS) {
      bloom[lvl].pct = pct(bloom[lvl].correct, bloom[lvl].total);
    }
  }

  // === Top students (≥2 attempts in 30d, sorted by avg pct desc) =========
  type TopRow = { name: string; class: string | null; avg_pct: number; attempts: number };
  const tops: TopRow[] = [];
  // Group attempts30 by student to compute avg + count.
  const att30ByStudent = new Map<string, AttemptRow[]>();
  for (const a of attempts30) {
    const arr = att30ByStudent.get(a.student_id) || [];
    arr.push(a);
    att30ByStudent.set(a.student_id, arr);
  }
  // Lowered from >=2 to >=1: see lib/teacherContext.ts for rationale —
  // matches the teacher coach so school + teacher coaches give the same
  // signal on a class with only one quiz so far.
  for (const [sid, atts] of att30ByStudent) {
    if (atts.length < 1) continue;
    const r = atts.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
    if (r.length === 0) continue;
    const avg = r.reduce((s, x) => s + x, 0) / r.length;
    tops.push({
      name: profById.get(sid)?.full_name || "(unnamed student)",
      class: studentClassName.get(sid) || null,
      avg_pct: Math.round(avg),
      attempts: atts.length,
    });
  }
  tops.sort((a, b) => b.avg_pct - a.avg_pct);
  const top_students = tops.slice(0, 5);

  // === At-risk (mirror AtRiskWatchlist logic) ============================
  type RiskRow = {
    name: string;
    class: string | null;
    signal: "low_score" | "declining" | "inactive";
    detail: string;
    sortKey: number;
    tier: 0 | 1 | 2;
  };
  const risks: RiskRow[] = [];
  for (const s of students) {
    const sid = s.id;
    const sAtts = attemptsByStudent.get(sid) || [];
    const last3 = sAtts.slice(0, 3);
    const pcts = last3
      .filter((a) => a.total > 0)
      .map((a) => (a.score / a.total) * 100);
    // Lowered from >=2 to >=1: see lib/teacherContext.ts for rationale.
    // A single attempt under 50% is a real signal worth surfacing to the
    // school admin. The detail string ("avg X% on last 1") keeps the
    // sample size visible.
    const last3Avg = pcts.length >= 1
      ? pcts.reduce((s2, x) => s2 + x, 0) / pcts.length
      : null;
    let declining = false;
    if (pcts.length >= 3 && last3.length >= 3) {
      declining = pcts[0] < pcts[1] && pcts[1] < pcts[2];
    }
    const lastActiveAt = sAtts[0]?.submitted_at ?? null;
    const inactiveDays = lastActiveAt
      ? Math.floor((now - new Date(lastActiveAt).getTime()) / 86_400_000)
      : Number.POSITIVE_INFINITY;
    const inClass = (studentToClasses.get(sid) || []).length > 0;

    let tier: 0 | 1 | 2 | null = null;
    if (last3Avg !== null && last3Avg < 50) tier = 0;
    else if (declining) tier = 1;
    else if (inactiveDays >= 14 && inClass) tier = 2;
    if (tier === null) continue;

    let detail = "";
    if (tier === 0) detail = `avg ${Math.round(last3Avg ?? 0)}% on last ${last3.length}`;
    else if (tier === 1) detail = `last 3 strictly declining (avg ${Math.round(last3Avg ?? 0)}%)`;
    else {
      const days = Number.isFinite(inactiveDays) ? inactiveDays : 999;
      detail = lastActiveAt
        ? `no attempts in ${days} days`
        : "no attempts ever";
    }

    let sortKey: number;
    if (tier === 0) sortKey = last3Avg ?? 0;
    else if (tier === 1) sortKey = last3Avg ?? 0;
    else sortKey = -(Number.isFinite(inactiveDays) ? inactiveDays : 9999);

    risks.push({
      name: s.full_name || "(unnamed student)",
      class: studentClassName.get(sid) || null,
      signal: tier === 0 ? "low_score" : tier === 1 ? "declining" : "inactive",
      detail,
      sortKey,
      tier,
    });
  }
  risks.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.sortKey - b.sortKey;
  });
  const at_risk = risks.slice(0, 5).map((r) => ({
    name: r.name,
    class: r.class,
    signal: r.signal,
    detail: r.detail,
  }));

  // === Engagement (last 7 vs prior 7) ====================================
  // Build local-day buckets going back 14 days. We use local time so days
  // line up with the principal's clock (matches EngagementTrends.tsx).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets14: { day: string; activeStudents: Set<string>; completions: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets14.push({ day: ymdLocal(d), activeStudents: new Set<string>(), completions: 0 });
  }
  const bucketByDay = new Map<string, { activeStudents: Set<string>; completions: number }>();
  for (const b of buckets14) bucketByDay.set(b.day, b);
  // Use attempts from last 14 days (subset of attemptsAll already filtered by submitted)
  const since14ms = today.getTime() - 13 * 86_400_000;
  for (const a of attemptsAll) {
    const t = new Date(a.submitted_at).getTime();
    if (t < since14ms) continue;
    const key = ymdLocal(new Date(a.submitted_at));
    const b = bucketByDay.get(key);
    if (!b) continue;
    b.completions += 1;
    b.activeStudents.add(a.student_id);
  }
  const last7 = buckets14.slice(7); // last 7 days incl. today
  const prior7 = buckets14.slice(0, 7);
  function avgDau(arr: typeof buckets14): number {
    if (arr.length === 0) return 0;
    return Math.round(
      arr.reduce((s, b) => s + b.activeStudents.size, 0) / arr.length
    );
  }
  function sumComp(arr: typeof buckets14): number {
    return arr.reduce((s, b) => s + b.completions, 0);
  }

  return {
    school: { id: school.id, name: school.name },
    asOf,
    totals: {
      teachers: teachers.length,
      students: students.length,
      classes: classes.length,
      quizzes: quizzesCount,
      attempts_30d: attempts30.length,
      avg_score_30d: avgScore30,
    },
    classes: classesOut,
    bloom_mastery_30d: bloom,
    top_students,
    at_risk,
    engagement: {
      last7_dau: avgDau(last7),
      prior7_dau: avgDau(prior7),
      last7_completions: sumComp(last7),
      prior7_completions: sumComp(prior7),
    },
  };
}
