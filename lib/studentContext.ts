// =============================================================================
// lib/studentContext.ts
// -----------------------------------------------------------------------------
// Server-only helper that builds a compact JSON snapshot of a single student's
// own performance state for the Student Coach + Weekly Brief features. Mirrors
// the shape of buildTeacherContext / buildSchoolContext but is scoped to ONE
// student (defence-in-depth: every query filters by student_id). We keep the
// payload under ~3KB so the LLM has plenty of headroom for its reply.
//
// The caller MUST verify the requesting user has role='student' before
// invoking us. We use the service-role client because aggregating across
// classmates (for class_avg_pct + my_rank) would otherwise be blocked by RLS.
// =============================================================================
import { supabaseAdmin } from "@/lib/supabase/server";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

export type StudentBloomMastery = {
  correct: number;
  total: number;
  pct: number | null;
};

export type StudentBloomTrend = {
  last_pct: number | null;
  prior_pct: number | null;
  delta: number | null;
};

export type StudentContext = {
  student: { id: string; name: string; is_school_student: boolean };
  asOf: string; // ISO timestamp
  totals: {
    attempts_30d: number;
    avg_score_30d: number | null;
    streak_days: number;
    last_active_iso: string | null;
  };
  bloom_mastery_30d: Record<BloomLevel, StudentBloomMastery>;
  bloom_trend_14d: Record<BloomLevel, StudentBloomTrend>;
  recent_attempts: Array<{ quiz_name: string; pct: number; submitted_at: string }>;
  weakest_topics: Array<{ topic: string; pct_correct: number; attempts: number }>;
  strongest_topics: Array<{ topic: string; pct_correct: number; attempts: number }>;
  class_context: {
    classes: Array<{
      id: string;
      name: string;
      my_avg_pct: number | null;
      class_avg_pct: number | null;
    }>;
    my_rank: number | null;
    class_size: number | null;
  } | null;
  subscription: {
    tier: "free" | "individual" | "premium";
    daily_attempts_used: number;
    daily_attempts_cap: number | null;
  } | null;
};

// === Local row types (admin client returns plain JSON) ====================
type ProfileRow = {
  id: string;
  full_name: string | null;
  is_school_student: boolean | null;
};
type AttemptRow = {
  id: string;
  quiz_id: string;
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
  topic: string | null;
};
type QuizRow = { id: string; name: string };
type ClassMemberRow = { class_id: string; student_id: string };
type ClassRow = { id: string; name: string };
type SubscriptionRow = { tier: string };
type SubscriptionLimitsRow = {
  free_daily_attempts: number | null;
  individual_daily_attempts: number | null;
  premium_daily_attempts: number | null;
};

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

function emptyBloomMastery(): Record<BloomLevel, StudentBloomMastery> {
  const out = {} as Record<BloomLevel, StudentBloomMastery>;
  for (const lvl of BLOOM_LEVELS) out[lvl] = { correct: 0, total: 0, pct: null };
  return out;
}

function emptyBloomTrend(): Record<BloomLevel, StudentBloomTrend> {
  const out = {} as Record<BloomLevel, StudentBloomTrend>;
  for (const lvl of BLOOM_LEVELS) {
    out[lvl] = { last_pct: null, prior_pct: null, delta: null };
  }
  return out;
}

export async function buildStudentContext(studentId: string): Promise<StudentContext> {
  const admin = supabaseAdmin();
  const asOf = new Date().toISOString();

  // === Profile ===========================================================
  const { data: profRaw } = await admin
    .from("profiles")
    .select("id, full_name, is_school_student")
    .eq("id", studentId)
    .maybeSingle();
  const prof = (profRaw as ProfileRow | null) || {
    id: studentId,
    full_name: null,
    is_school_student: false,
  };
  const isSchoolStudent = !!prof.is_school_student;

  // === Attempts (last 30d, submitted) ====================================
  const now = Date.now();
  const since30 = new Date(now - 30 * 86_400_000).toISOString();
  const { data: att30Raw } = await admin
    .from("quiz_attempts")
    .select("id, quiz_id, score, total, submitted_at")
    .eq("student_id", studentId)
    .not("submitted_at", "is", null)
    .gte("submitted_at", since30)
    .order("submitted_at", { ascending: false });
  const attempts30: AttemptRow[] = (att30Raw as AttemptRow[] | null) || [];

  const ratios30 = attempts30.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
  const avgScore30 = ratios30.length
    ? Math.round(ratios30.reduce((s, x) => s + x, 0) / ratios30.length)
    : null;

  const lastActiveIso = attempts30[0]?.submitted_at ?? null;

  // === Streak (consecutive local-day buckets ending today) ===============
  const daysWithAttempts = new Set<string>();
  for (const a of attempts30) {
    daysWithAttempts.add(ymdLocal(new Date(a.submitted_at)));
  }
  let streak_days = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // Walk backwards day-by-day. Stop when we hit a day with no attempts.
  // We allow today itself to be "missing" only if no attempt yet today —
  // in that case the streak starts from yesterday.
  if (!daysWithAttempts.has(ymdLocal(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (daysWithAttempts.has(ymdLocal(cursor))) {
    streak_days += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  // === Bloom mastery (last 30d) ==========================================
  const bloom = emptyBloomMastery();
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

  // === Bloom trend (last 14d vs prior 14d, i.e. days 28-15) ==============
  const bloomTrend = emptyBloomTrend();
  if (allAns.length > 0) {
    const since14ms = now - 14 * 86_400_000;
    const since28ms = now - 28 * 86_400_000;
    const attemptDateById = new Map<string, number>();
    for (const a of attempts30) {
      attemptDateById.set(a.id, new Date(a.submitted_at).getTime());
    }
    type Window = Record<BloomLevel, { correct: number; total: number }>;
    const last14: Window = {} as Window;
    const prior14: Window = {} as Window;
    for (const lvl of BLOOM_LEVELS) {
      last14[lvl] = { correct: 0, total: 0 };
      prior14[lvl] = { correct: 0, total: 0 };
    }
    for (const row of allAns) {
      if (!row.bloom_level) continue;
      const lvl = row.bloom_level as BloomLevel;
      if (!(BLOOM_LEVELS as readonly string[]).includes(lvl)) continue;
      const t = attemptDateById.get(row.attempt_id);
      if (t === undefined) continue;
      let bucket: { correct: number; total: number } | null = null;
      if (t >= since14ms) bucket = last14[lvl];
      else if (t >= since28ms) bucket = prior14[lvl];
      if (!bucket) continue;
      bucket.total += 1;
      if (row.is_correct) bucket.correct += 1;
    }
    for (const lvl of BLOOM_LEVELS) {
      const lp = pct(last14[lvl].correct, last14[lvl].total);
      const pp = pct(prior14[lvl].correct, prior14[lvl].total);
      const delta = lp !== null && pp !== null ? lp - pp : null;
      bloomTrend[lvl] = { last_pct: lp, prior_pct: pp, delta };
    }
  }

  // === Recent attempts (last 5) ==========================================
  const recentSlice = attempts30.slice(0, 5);
  const recentQuizIds = Array.from(new Set(recentSlice.map((a) => a.quiz_id)));
  const quizNameById = new Map<string, string>();
  if (recentQuizIds.length > 0) {
    const { data: qRaw } = await admin
      .from("quizzes")
      .select("id, name")
      .in("id", recentQuizIds);
    const quizzes = (qRaw as QuizRow[] | null) || [];
    for (const q of quizzes) quizNameById.set(q.id, q.name);
  }
  const recent_attempts = recentSlice
    .filter((a) => a.total > 0)
    .map((a) => ({
      quiz_name: quizNameById.get(a.quiz_id) || "Quiz",
      pct: Math.round((a.score / a.total) * 100),
      submitted_at: a.submitted_at,
    }));

  // === Weakest / strongest topics (≥3 attempts) ==========================
  type TopicStat = { correct: number; total: number };
  const topicStats = new Map<string, TopicStat>();
  if (allAns.length > 0) {
    const qIds = Array.from(new Set(allAns.map((a) => a.question_id)));
    const topicByQ = new Map<string, string>();
    const chunkSize = 500;
    for (let i = 0; i < qIds.length; i += chunkSize) {
      const slice = qIds.slice(i, i + chunkSize);
      const { data: qbRaw } = await admin
        .from("question_bank")
        .select("id, topic")
        .in("id", slice);
      const qb = (qbRaw as QuestionBankRow[] | null) || [];
      for (const q of qb) topicByQ.set(q.id, q.topic || "Untitled topic");
    }
    for (const row of allAns) {
      const topic = topicByQ.get(row.question_id) || "Untitled topic";
      const stat = topicStats.get(topic) || { correct: 0, total: 0 };
      stat.total += 1;
      if (row.is_correct) stat.correct += 1;
      topicStats.set(topic, stat);
    }
  }
  const topicRows: Array<{ topic: string; pct_correct: number; attempts: number }> = [];
  for (const [topic, stat] of topicStats) {
    if (stat.total < 3) continue;
    topicRows.push({
      topic,
      pct_correct: Math.round((stat.correct / stat.total) * 100),
      attempts: stat.total,
    });
  }
  const weakest_topics = [...topicRows]
    .sort((a, b) => a.pct_correct - b.pct_correct)
    .slice(0, 3);
  const strongest_topics = [...topicRows]
    .sort((a, b) => b.pct_correct - a.pct_correct)
    .slice(0, 3);

  // === Class context (school students only) ==============================
  let class_context: StudentContext["class_context"] = null;
  if (isSchoolStudent) {
    const { data: cmRaw } = await admin
      .from("class_members")
      .select("class_id, student_id")
      .eq("student_id", studentId);
    const myMemberships = (cmRaw as ClassMemberRow[] | null) || [];
    const myClassIds = Array.from(new Set(myMemberships.map((m) => m.class_id)));

    if (myClassIds.length > 0) {
      const { data: cRaw } = await admin
        .from("classes")
        .select("id, name")
        .in("id", myClassIds);
      const classes = (cRaw as ClassRow[] | null) || [];
      const classNameById = new Map<string, string>();
      for (const c of classes) classNameById.set(c.id, c.name);

      // Fetch every member of every class the student is in.
      const { data: allMembersRaw } = await admin
        .from("class_members")
        .select("class_id, student_id")
        .in("class_id", myClassIds);
      const allMembers = (allMembersRaw as ClassMemberRow[] | null) || [];
      const allClassmateIds = Array.from(new Set(allMembers.map((m) => m.student_id)));

      // Pull 30d attempts for all classmates so we can compute class avgs.
      let classmateAttempts: Array<{
        student_id: string;
        score: number;
        total: number;
      }> = [];
      if (allClassmateIds.length > 0) {
        const { data: ratData } = await admin
          .from("quiz_attempts")
          .select("student_id, score, total, submitted_at")
          .in("student_id", allClassmateIds)
          .not("submitted_at", "is", null)
          .gte("submitted_at", since30);
        classmateAttempts =
          (ratData as Array<{
            student_id: string;
            score: number;
            total: number;
            submitted_at: string;
          }> | null) || [];
      }
      // Group attempts by student.
      const ratiosByStudent = new Map<string, number[]>();
      for (const a of classmateAttempts) {
        if (!a.total || a.total <= 0) continue;
        const arr = ratiosByStudent.get(a.student_id) || [];
        arr.push((a.score / a.total) * 100);
        ratiosByStudent.set(a.student_id, arr);
      }
      // Per-student avg.
      const avgByStudent = new Map<string, number | null>();
      for (const [sid, ratios] of ratiosByStudent) {
        if (ratios.length === 0) avgByStudent.set(sid, null);
        else avgByStudent.set(sid, ratios.reduce((s, x) => s + x, 0) / ratios.length);
      }

      // Per-class roll-ups.
      const membersByClass = new Map<string, string[]>();
      for (const m of allMembers) {
        const arr = membersByClass.get(m.class_id) || [];
        arr.push(m.student_id);
        membersByClass.set(m.class_id, arr);
      }
      const classesOut = classes.map((c) => {
        const members = membersByClass.get(c.id) || [];
        const ratios: number[] = [];
        let myRatios: number[] = [];
        for (const sid of members) {
          const r = ratiosByStudent.get(sid) || [];
          ratios.push(...r);
          if (sid === studentId) myRatios = r;
        }
        const class_avg_pct = ratios.length
          ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length)
          : null;
        const my_avg_pct = myRatios.length
          ? Math.round(myRatios.reduce((s, x) => s + x, 0) / myRatios.length)
          : null;
        return {
          id: c.id,
          name: classNameById.get(c.id) || "Class",
          my_avg_pct,
          class_avg_pct,
        };
      });

      // Rank: take the largest of the student's classes by member count and
      // rank within that. This mirrors the "your class" mental model.
      let my_rank: number | null = null;
      let class_size: number | null = null;
      let primaryClassId: string | null = null;
      let primaryCount = -1;
      for (const cid of myClassIds) {
        const members = membersByClass.get(cid) || [];
        if (members.length > primaryCount) {
          primaryCount = members.length;
          primaryClassId = cid;
        }
      }
      if (primaryClassId) {
        const members = membersByClass.get(primaryClassId) || [];
        class_size = members.length;
        // Build [studentId, avgOrNull] tuples; rank by avg desc, NULLs last.
        const rows = members.map((sid) => ({
          sid,
          avg: avgByStudent.get(sid) ?? null,
        }));
        rows.sort((a, b) => {
          if (a.avg === null && b.avg === null) return 0;
          if (a.avg === null) return 1;
          if (b.avg === null) return -1;
          return b.avg - a.avg;
        });
        const idx = rows.findIndex((r) => r.sid === studentId);
        if (idx >= 0 && rows[idx].avg !== null) {
          my_rank = idx + 1;
        }
      }

      class_context = {
        classes: classesOut,
        my_rank,
        class_size,
      };
    } else {
      class_context = { classes: [], my_rank: null, class_size: null };
    }
  }

  // === Subscription (independent students only) ==========================
  let subscription: StudentContext["subscription"] = null;
  if (!isSchoolStudent) {
    let tier: "free" | "individual" | "premium" = "free";
    try {
      const { data: subRaw } = await admin
        .from("subscriptions")
        .select("tier")
        .eq("user_id", studentId)
        .maybeSingle();
      const sub = subRaw as SubscriptionRow | null;
      if (sub?.tier === "individual" || sub?.tier === "premium" || sub?.tier === "free") {
        tier = sub.tier;
      }
    } catch {
      /* table may not exist on old DB versions — fall through */
    }

    // Daily attempts used = today's attempts (local day).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const since24 = new Date(now - 24 * 3_600_000).toISOString();
    let daily_attempts_used = 0;
    try {
      const { data: todayAttRaw } = await admin
        .from("quiz_attempts")
        .select("id, started_at")
        .eq("student_id", studentId)
        .gte("started_at", since24);
      const rows =
        (todayAttRaw as Array<{ id: string; started_at: string }> | null) || [];
      // Only count those that fall on today's local date.
      for (const r of rows) {
        const t = new Date(r.started_at).getTime();
        if (t >= todayMs) daily_attempts_used += 1;
      }
    } catch {
      /* ignore */
    }

    let daily_attempts_cap: number | null = null;
    try {
      const { data: limRaw } = await admin
        .from("subscription_limits")
        .select("free_daily_attempts, individual_daily_attempts, premium_daily_attempts")
        .eq("id", 1)
        .maybeSingle();
      const lim = limRaw as SubscriptionLimitsRow | null;
      if (lim) {
        if (tier === "free") daily_attempts_cap = lim.free_daily_attempts ?? null;
        else if (tier === "individual") daily_attempts_cap = lim.individual_daily_attempts ?? null;
        else if (tier === "premium") daily_attempts_cap = lim.premium_daily_attempts ?? null;
      }
    } catch {
      /* table missing — leave cap as null */
    }

    subscription = {
      tier,
      daily_attempts_used,
      daily_attempts_cap,
    };
  }

  return {
    student: {
      id: prof.id,
      name: prof.full_name || "Student",
      is_school_student: isSchoolStudent,
    },
    asOf,
    totals: {
      attempts_30d: attempts30.length,
      avg_score_30d: avgScore30,
      streak_days,
      last_active_iso: lastActiveIso,
    },
    bloom_mastery_30d: bloom,
    bloom_trend_14d: bloomTrend,
    recent_attempts,
    weakest_topics,
    strongest_topics,
    class_context,
    subscription,
  };
}
