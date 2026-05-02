"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Quiz } from "@/lib/types";
import Empty from "@/components/Empty";
import { NotebookPen, Play, Trash2, Sparkles } from "lucide-react";
import BloomHero from "@/components/BloomHero";
import { loadClassQuizIds } from "@/lib/studentScope";
import { pct } from "@/lib/utils";

// =============================================================================
// "My practice" — the student's PERSONAL PRACTICE landing.
//
// Hard rule: this page is personal-practice only. Class-assigned
// quizzes (the official record) never appear here, never count toward
// the stats, never feed the BloomHero. Class-scope work lives at
// /student/progress and on the dashboard's "Assigned to you" panel,
// kept fully separate so a student / parent / teacher reading either
// surface always knows exactly what they're looking at.
//
// The page has three sections:
//   1. Practice stats trio (tests taken, average) — practice attempts only.
//   2. Practice BloomHero — mastery from practice attempts only.
//   3. List of self-generated practice quizzes (owner_id = me).
//
// Per CONVENTIONS.md these are "Practice" (not Tests, despite the
// legacy /student/tests route). The route stays for backward-compat;
// UI labels say "practice".
// =============================================================================

type Row = Quiz & { questionCount?: number; lastAttemptAt?: string | null; lastScore?: { score: number; total: number } | null };

type BloomBreakdown = Record<string, { correct: number; total: number }>;

export default function MyPracticePage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  // Practice-only stats. These NEVER include class-assigned attempts.
  const [practiceTaken, setPracticeTaken] = useState(0);
  const [practiceAvg, setPracticeAvg] = useState(0);
  const [practiceMastery, setPracticeMastery] = useState<BloomBreakdown>({});

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    // ---- Practice stats + Bloom mastery -------------------------------
    // Pull ALL the student's submitted attempts, then drop anything
    // that's class-assigned. What's left is personal practice.
    const [{ data: allAtts }, classQuizIds] = await Promise.all([
      sb
        .from("quiz_attempts")
        .select("id, score, total, quiz_id, submitted_at")
        .eq("student_id", user.id)
        .not("submitted_at", "is", null),
      loadClassQuizIds(sb),
    ]);
    type AttRow = { id: string; score: number; total: number; quiz_id: string; submitted_at: string | null };
    const submittedAll = ((allAtts as AttRow[]) || []);
    const practiceAtts = submittedAll.filter((a) => a.quiz_id && !classQuizIds.has(a.quiz_id));

    setPracticeTaken(practiceAtts.length);
    setPracticeAvg(
      practiceAtts.length
        ? Math.round(practiceAtts.reduce((s, a) => s + pct(a.score, a.total), 0) / practiceAtts.length)
        : 0,
    );

    if (practiceAtts.length > 0) {
      const ids = practiceAtts.map((a) => a.id);
      const { data: ans } = await sb
        .from("attempt_answers")
        .select("bloom_level, is_correct")
        .in("attempt_id", ids);
      const breakdown: BloomBreakdown = {};
      ((ans as Array<{ bloom_level: string; is_correct: boolean | null }>) || []).forEach((a) => {
        if (!breakdown[a.bloom_level]) breakdown[a.bloom_level] = { correct: 0, total: 0 };
        breakdown[a.bloom_level].total++;
        if (a.is_correct) breakdown[a.bloom_level].correct++;
      });
      setPracticeMastery(breakdown);
    } else {
      setPracticeMastery({});
    }

    // ---- List of practice quizzes -------------------------------------
    // The student's self-generated quizzes (owner_id = them). Hydrate
    // each row with question count + last attempt for the list view.
    const { data: qs } = await sb.from("quizzes").select("*").eq("owner_id", user.id).order("created_at", { ascending: false });
    const list = (qs as Quiz[]) || [];

    const rows: Row[] = await Promise.all(list.map(async (q) => {
      const [{ count: qCount }, { data: atts }] = await Promise.all([
        sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", q.id),
        sb.from("quiz_attempts")
          .select("submitted_at, score, total")
          .eq("quiz_id", q.id)
          .eq("student_id", user.id)
          .order("submitted_at", { ascending: false, nullsFirst: false })
          .limit(1),
      ]);
      const last = (atts as Array<{ submitted_at: string | null; score: number; total: number }> | null)?.[0];
      return {
        ...q,
        questionCount: qCount || 0,
        lastAttemptAt: last?.submitted_at || null,
        lastScore: last && last.submitted_at ? { score: last.score, total: last.total } : null,
      };
    }));
    setItems(rows);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}"? Your past attempts and scores are kept; only this practice quiz goes away.`)) return;
    const sb = supabaseBrowser();
    const { error } = await sb.from("quizzes").delete().eq("id", id);
    if (error) {
      alert(`Could not delete: ${error.message}`);
      return;
    }
    setItems((arr) => arr.filter((q) => q.id !== id));
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  const hasPracticeData = practiceTaken > 0;

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1 flex items-center gap-2"><NotebookPen size={28} /> My Practice</h1>
          <p className="muted mt-1">
            Self-study only. Class quizzes assigned by your teacher are kept on a separate
            page and don&apos;t affect any of the numbers below.
          </p>
        </div>
        <Link href="/student/generate" className="btn btn-primary"><Sparkles size={16} /> New practice</Link>
      </div>

      {/* Practice stats trio — personal-practice scope only. */}
      {hasPracticeData ? (
        <div className="grid sm:grid-cols-2 gap-3 mt-6">
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Practice tests taken</div>
            <div className="text-3xl font-bold">{practiceTaken}</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Practice average</div>
            <div className="text-3xl font-bold">{practiceAvg}%</div>
          </div>
        </div>
      ) : null}

      {/* Practice BloomHero — mastery from practice attempts only. */}
      {hasPracticeData && (
        <div className="mt-4">
          <BloomHero mastery={practiceMastery} />
        </div>
      )}

      {/* List of practice quizzes — the catalogue you can retake. */}
      <h2 className="h2 mt-8 mb-3">Your practice quizzes</h2>
      {items.length === 0 ? (
        <Empty
          icon="🎯"
          title="No practice yet"
          body="Generate your first practice quiz to start drilling."
          action={<Link href="/student/generate" className="btn btn-primary">Create practice</Link>}
        />
      ) : (
        <div className="space-y-2">
          {items.map((t) => (
            <div key={t.id} className="card flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{t.name}</div>
                <div className="text-xs muted mt-0.5 flex items-center gap-3 flex-wrap">
                  <span>{t.questionCount} questions · {t.time_limit_minutes} min</span>
                  {t.subject && <span>Topic: {t.subject}</span>}
                  <span>Created {new Date(t.created_at).toLocaleDateString()}</span>
                  {t.lastScore && (
                    <span className="text-emerald-700 font-medium">
                      Last: {t.lastScore.score}/{t.lastScore.total}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link href={`/student/quiz/${t.code}`} className="btn btn-primary">
                  <Play size={14} /> {t.lastAttemptAt ? "Retake" : "Start"}
                </Link>
                <button className="btn btn-ghost text-red-600" onClick={() => remove(t.id, t.name)} title="Delete practice">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
