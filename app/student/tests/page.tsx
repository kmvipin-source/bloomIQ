"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Quiz } from "@/lib/types";
import Empty from "@/components/Empty";
import { NotebookPen, Play, Trash2, Sparkles } from "lucide-react";

// =============================================================================
// "My practice" — student's self-generated quizzes.
//
// These are NEVER graded by a teacher, so per CONVENTIONS.md they are
// "Practice" (not Tests, despite the legacy `/student/tests` route). The
// route stays for backward-compat; UI labels say "practice".
// =============================================================================

type Row = Quiz & { questionCount?: number; lastAttemptAt?: string | null; lastScore?: { score: number; total: number } | null };

export default function MyPracticePage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const { data: qs } = await sb.from("quizzes").select("*").eq("owner_id", user.id).order("created_at", { ascending: false });
    const list = (qs as Quiz[]) || [];

    // Hydrate question counts + last attempt for each item
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

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1 flex items-center gap-2"><NotebookPen size={28} /> My practice</h1>
          <p className="muted mt-1">Your self-generated practice quizzes. Retake any of them anytime.</p>
        </div>
        <Link href="/student/generate" className="btn btn-primary"><Sparkles size={16} /> New practice</Link>
      </div>

      {items.length === 0 ? (
        <Empty
          icon="🎯"
          title="No practice yet"
          body="Generate your first practice quiz to start drilling."
          action={<Link href="/student/generate" className="btn btn-primary">Create practice</Link>}
        />
      ) : (
        <div className="space-y-2 mt-6">
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
