// =============================================================================
// lib/teacherContext.ts
// -----------------------------------------------------------------------------
// Server-only helper that builds a compact JSON snapshot of a single teacher's
// classroom state for the Teacher Coach + Weekly Brief features. Mirrors the
// shape of buildSchoolContext but is scoped to the classes the teacher is on
// via class_teachers (either as 'primary' or 'co'). We keep the payload under
// ~3KB so the LLM has plenty of headroom for its reply.
//
// The caller MUST verify the requesting user is a teacher before invoking us.
// We use the service-role client because aggregating across many students'
// attempts would be blocked by RLS otherwise — auth has already happened.
// =============================================================================
import { supabaseAdmin } from "@/lib/supabase/server";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

export type TeacherBloomMastery = {
  correct: number;
  total: number;
  pct: number | null;
};

export type TeacherContext = {
  teacher: { id: string; name: string };
  asOf: string; // ISO timestamp
  classes: Array<{
    id: string;
    name: string;
    role: "primary" | "co" | "acting";
    students: number;
    attempts_30d: number;
    avg_score_30d: number | null;
  }>;
  totals: {
    classes: number;
    students: number;
    quizzes_owned: number;
    attempts_30d: number;
    avg_score_30d: number | null;
  };
  bloom_mastery_30d: Record<BloomLevel, TeacherBloomMastery>;
  top_students: Array<{
    name: string;
    class: string | null;
    avg_pct: number;
    attempts: number;
  }>; // top 5 across teacher's classes
  at_risk: Array<{
    name: string;
    class: string | null;
    signal: "low_score" | "declining" | "inactive";
    detail: string;
  }>; // top 5
  most_missed_questions: Array<{
    stem: string;
    topic: string | null;
    bloom_level: string | null;
    pct_correct: number;
    attempts: number;
  }>; // top 5 questions in teacher's bank with worst pct in last 30d (>=3 attempts)
  engagement: {
    last7_dau: number;
    prior7_dau: number;
    last7_completions: number;
    prior7_completions: number;
  };
};

// === Local row types (admin client returns plain JSON) ====================
type ProfileRow = { id: string; full_name: string | null };
type ClassRow = { id: string; name: string };
type ClassTeacherRow = { class_id: string; role: string };
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
  question_id: string;
  bloom_level: string | null;
  is_correct: boolean | null;
};
type QuestionBankRow = {
  id: string;
  owner_id: string;
  stem: string;
  topic: string | null;
  bloom_level: string | null;
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

function emptyBloomMastery(): Record<BloomLevel, TeacherBloomMastery> {
  const out = {} as Record<BloomLevel, TeacherBloomMastery>;
  for (const lvl of BLOOM_LEVELS) out[lvl] = { correct: 0, total: 0, pct: null };
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

export async function buildTeacherContext(teacherId: string): Promise<TeacherContext> {
  const admin = supabaseAdmin();
  const asOf = new Date().toISOString();

  // === Teacher profile ===================================================
  const { data: teacherProfRaw } = await admin
    .from("profiles")
    .select("id, full_name")
    .eq("id", teacherId)
    .maybeSingle();
  const teacherProf = (teacherProfRaw as ProfileRow | null) || {
    id: teacherId,
    full_name: null,
  };

  // === Classes the teacher is on (primary OR co) =========================
  const { data: ctRaw } = await admin
    .from("class_teachers")
    .select("class_id, role")
    .eq("teacher_id", teacherId);
  const classTeachers: ClassTeacherRow[] = (ctRaw as ClassTeacherRow[] | null) || [];

  // Acting cover teachers are surfaced distinctly from co-teachers —
  // class-context normalises acting → primary for permissions, but the
  // LLM snapshot keeps the distinction so the digest copy can reflect
  // "Acting Primary on Class 9-B" accurately. Primary wins ties, then
  // acting, then co.
  const roleByClass = new Map<string, "primary" | "co" | "acting">();
  const rank = { primary: 3, acting: 2, co: 1 } as const;
  for (const ct of classTeachers) {
    const role: "primary" | "co" | "acting" =
      ct.role === "primary" ? "primary"
      : ct.role === "acting" ? "acting"
      : "co";
    const existing = roleByClass.get(ct.class_id);
    if (existing && rank[existing] >= rank[role]) continue;
    roleByClass.set(ct.class_id, role);
  }
  const classIds = Array.from(roleByClass.keys());

  // === Class rows ========================================================
  let classes: ClassRow[] = [];
  if (classIds.length > 0) {
    const { data: cRaw } = await admin
      .from("classes")
      .select("id, name")
      .in("id", classIds)
      .eq("status", "active");
    classes = (cRaw as ClassRow[] | null) || [];
  }
  const classNameById = new Map<string, string>();
  for (const c of classes) classNameById.set(c.id, c.name);

  // === Class members =====================================================
  let classMembers: ClassMemberRow[] = [];
  if (classIds.length > 0) {
    const { data: cmRaw } = await admin
      .from("class_members")
      .select("class_id, student_id")
      .in("class_id", classIds);
    classMembers = (cmRaw as ClassMemberRow[] | null) || [];
  }

  const studentToClasses = new Map<string, string[]>();
  for (const m of classMembers) {
    const arr = studentToClasses.get(m.student_id) || [];
    arr.push(m.class_id);
    studentToClasses.set(m.student_id, arr);
  }
  // Display class for each student = first class we encounter belonging to
  // this teacher.
  const studentClassName = new Map<string, string>();
  for (const m of classMembers) {
    if (!studentClassName.has(m.student_id)) {
      const name = classNameById.get(m.class_id);
      if (name) studentClassName.set(m.student_id, name);
    }
  }
  const classStudentCount = new Map<string, number>();
  for (const c of classes) classStudentCount.set(c.id, 0);
  for (const m of classMembers) {
    classStudentCount.set(m.class_id, (classStudentCount.get(m.class_id) || 0) + 1);
  }

  const studentIds = Array.from(new Set(classMembers.map((m) => m.student_id)));

  // === Student profiles (for names) ======================================
  let studentProfiles: ProfileRow[] = [];
  if (studentIds.length > 0) {
    const { data: spRaw } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", studentIds);
    studentProfiles = (spRaw as ProfileRow[] | null) || [];
  }
  const studentProfById = new Map<string, ProfileRow>();
  for (const p of studentProfiles) studentProfById.set(p.id, p);

  // === Quizzes owned by this teacher (count) =============================
  const { count: quizzesCount } = await admin
    .from("quizzes")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", teacherId);

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

  const ratios30 = attempts30.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
  const avgScore30 = ratios30.length
    ? Math.round(ratios30.reduce((s, x) => s + x, 0) / ratios30.length)
    : null;

  // === All-time attempts per student (for top_students + at_risk) ========
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

  const classesOut = classes.map((c) => {
    const agg = classAgg.get(c.id) || { ratios: [], attempts: 0 };
    const avg = agg.ratios.length
      ? Math.round(agg.ratios.reduce((s, x) => s + x, 0) / agg.ratios.length)
      : null;
    return {
      id: c.id,
      name: c.name,
      role: roleByClass.get(c.id) || "co",
      students: classStudentCount.get(c.id) || 0,
      attempts_30d: agg.attempts,
      avg_score_30d: avg,
    };
  });

  // === Bloom mastery + most-missed (last 30 days) ========================
  const bloom = emptyBloomMastery();
  // Per-question stats keyed by question_id.
  type QStat = { correct: number; total: number };
  const qStats = new Map<string, QStat>();
  let allAns: AttemptAnswerRow[] = [];

  if (attempts30.length > 0) {
    const attemptIds = attempts30.map((a) => a.id);
    const chunkSize = 500;
    for (let i = 0; i < attemptIds.length; i += chunkSize) {
      const slice = attemptIds.slice(i, i + chunkSize);
      const { data: ans } = await admin
        .from("attempt_answers")
        .select("attempt_id, question_id, bloom_level, is_correct")
        .in("attempt_id", slice);
      if (ans) allAns.push(...(ans as AttemptAnswerRow[]));
    }
    for (const row of allAns) {
      // Bloom mastery roll-up.
      if (row.bloom_level) {
        const lvl = row.bloom_level as BloomLevel;
        if ((BLOOM_LEVELS as readonly string[]).includes(lvl)) {
          bloom[lvl].total += 1;
          if (row.is_correct) bloom[lvl].correct += 1;
        }
      }
      // Per-question stats.
      const stat = qStats.get(row.question_id) || { correct: 0, total: 0 };
      stat.total += 1;
      if (row.is_correct) stat.correct += 1;
      qStats.set(row.question_id, stat);
    }
    for (const lvl of BLOOM_LEVELS) {
      bloom[lvl].pct = pct(bloom[lvl].correct, bloom[lvl].total);
    }
  }

  // === Most-missed questions (this teacher's question_bank, >=3 attempts) =
  let most_missed_questions: TeacherContext["most_missed_questions"] = [];
  const qIds = Array.from(qStats.keys());
  if (qIds.length > 0) {
    const chunkSize = 500;
    const teacherQuestions: QuestionBankRow[] = [];
    for (let i = 0; i < qIds.length; i += chunkSize) {
      const slice = qIds.slice(i, i + chunkSize);
      const { data: qbRaw } = await admin
        .from("question_bank")
        .select("id, owner_id, stem, topic, bloom_level")
        .in("id", slice)
        .eq("owner_id", teacherId);
      if (qbRaw) teacherQuestions.push(...(qbRaw as QuestionBankRow[]));
    }
    type Missed = {
      stem: string;
      topic: string | null;
      bloom_level: string | null;
      pct_correct: number;
      attempts: number;
    };
    const missed: Missed[] = [];
    for (const q of teacherQuestions) {
      const stat = qStats.get(q.id);
      if (!stat || stat.total < 3) continue;
      missed.push({
        stem: truncate(q.stem || "", 120),
        topic: q.topic,
        bloom_level: q.bloom_level,
        pct_correct: Math.round((stat.correct / stat.total) * 100),
        attempts: stat.total,
      });
    }
    missed.sort((a, b) => a.pct_correct - b.pct_correct);
    most_missed_questions = missed.slice(0, 5);
  }

  // === Top students (>=2 attempts in 30d) ================================
  type TopRow = { name: string; class: string | null; avg_pct: number; attempts: number };
  const tops: TopRow[] = [];
  const att30ByStudent = new Map<string, AttemptRow[]>();
  for (const a of attempts30) {
    const arr = att30ByStudent.get(a.student_id) || [];
    arr.push(a);
    att30ByStudent.set(a.student_id, arr);
  }
  // Originally required >=2 attempts so a single fluke score didn't crown a
  // student. But for a class with just one quiz so far, that threshold left
  // top_students empty even when a student aced the only test. Fall open at
  // >=1 attempt — the avg_pct + attempts count are still surfaced, so the
  // teacher (and the Coach) can weight the signal appropriately.
  for (const [sid, atts] of att30ByStudent) {
    if (atts.length < 1) continue;
    const r = atts.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
    if (r.length === 0) continue;
    const avg = r.reduce((s, x) => s + x, 0) / r.length;
    tops.push({
      name: studentProfById.get(sid)?.full_name || "(unnamed student)",
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
  for (const sid of studentIds) {
    const sAtts = attemptsByStudent.get(sid) || [];
    const last3 = sAtts.slice(0, 3);
    const pcts = last3
      .filter((a) => a.total > 0)
      .map((a) => (a.score / a.total) * 100);
    // Originally required pcts.length >= 2 so a single weak attempt didn't
    // tar a student as at_risk. But that left a class with only one quiz
    // taken with NO at_risk signal at all — exactly the case where the
    // teacher most needs the heads-up. Fall open at >=1: a single attempt
    // <50% is a worth-flagging signal on its own, and the detail string
    // makes the sample size honest ("avg X% on last 1").
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
      name: studentProfById.get(sid)?.full_name || "(unnamed student)",
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  type Bucket = { day: string; activeStudents: Set<string>; completions: number };
  const buckets14: Bucket[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets14.push({ day: ymdLocal(d), activeStudents: new Set<string>(), completions: 0 });
  }
  const bucketByDay = new Map<string, Bucket>();
  for (const b of buckets14) bucketByDay.set(b.day, b);
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
  const last7 = buckets14.slice(7);
  const prior7 = buckets14.slice(0, 7);
  function avgDau(arr: Bucket[]): number {
    if (arr.length === 0) return 0;
    return Math.round(
      arr.reduce((s, b) => s + b.activeStudents.size, 0) / arr.length
    );
  }
  function sumComp(arr: Bucket[]): number {
    return arr.reduce((s, b) => s + b.completions, 0);
  }

  return {
    teacher: { id: teacherProf.id, name: teacherProf.full_name || "Teacher" },
    asOf,
    classes: classesOut,
    totals: {
      classes: classes.length,
      students: studentIds.length,
      quizzes_owned: quizzesCount || 0,
      attempts_30d: attempts30.length,
      avg_score_30d: avgScore30,
    },
    bloom_mastery_30d: bloom,
    top_students,
    at_risk,
    most_missed_questions,
    engagement: {
      last7_dau: avgDau(last7),
      prior7_dau: avgDau(prior7),
      last7_completions: sumComp(last7),
      prior7_completions: sumComp(prior7),
    },
  };
}
