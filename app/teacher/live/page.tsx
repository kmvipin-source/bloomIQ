"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Radio, Play, ArrowLeft } from "lucide-react";

type QuizRow = {
  id: string;
  name: string;
  code: string;
  subject: string | null;
  question_count: number;
};

export default function TeacherLivePicker() {
  const router = useRouter();
  const [quizzes, setQuizzes] = useState<QuizRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [seconds, setSeconds] = useState(30);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data } = await sb
        .from("quizzes")
        .select("id, name, code, subject")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      const list = ((data as Array<{ id: string; name: string; code: string; subject: string | null }>) || []);
      const ids = list.map((q) => q.id);
      const counts = new Map<string, number>();
      if (ids.length > 0) {
        const { data: qq } = await sb
          .from("quiz_questions")
          .select("quiz_id, question_id")
          .in("quiz_id", ids);
        ((qq as Array<{ quiz_id: string }> | null) || []).forEach((r) => {
          counts.set(r.quiz_id, (counts.get(r.quiz_id) || 0) + 1);
        });
      }
      setQuizzes(list.map((q) => ({ ...q, question_count: counts.get(q.id) || 0 })));
      setLoading(false);
    })();
  }, []);

  async function host(quizId: string) {
    setBusyId(quizId); setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Please sign in.");
      const res = await fetch("/api/live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ quiz_id: quizId, seconds_per_question: seconds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start.");
      router.push(`/teacher/live/${data.code}/host`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/teacher" className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>
      <div className="flex items-center gap-3 mt-2">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-fuchsia-500 to-rose-500 text-white grid place-items-center">
          <Radio size={20} />
        </div>
        <div>
          <h1 className="h1">Live class quiz</h1>
          <p className="muted text-sm">Pick a quiz to host. Students join with the 6-character code on the next screen.</p>
        </div>
      </div>

      <div className="mt-6 card flex items-center gap-3 flex-wrap">
        <label className="text-sm font-medium">Seconds per question</label>
        <input
          type="number"
          min={5}
          max={180}
          className="input w-24"
          value={seconds}
          onChange={(e) => setSeconds(Math.max(5, Math.min(180, Number(e.target.value) || 30)))}
        />
        <span className="text-xs muted">applies to whichever quiz you host</span>
      </div>

      {err && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

      <h2 className="h2 mt-6 mb-2">Your quizzes</h2>
      {loading ? (
        <div className="grid place-items-center py-12"><div className="spinner" /></div>
      ) : quizzes.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-4xl mb-2">📭</div>
          <div className="font-semibold mb-1">No quizzes yet</div>
          <div className="muted text-sm mb-4">Compose a quiz first, then come back to host it live.</div>
          <Link href="/teacher/quizzes/new" className="btn btn-primary inline-flex">Compose a quiz</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {quizzes.map((q) => (
            <div key={q.id} className="card flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{q.name}</div>
                <div className="text-xs muted mt-0.5">
                  {q.subject ? <span className="mr-2">{q.subject}</span> : null}
                  {q.question_count} question{q.question_count === 1 ? "" : "s"}
                  <span className="ml-2"><code className="text-[11px] px-1.5 py-0.5 bg-slate-100 rounded">{q.code}</code></span>
                </div>
              </div>
              <button
                onClick={() => host(q.id)}
                disabled={busyId !== null || q.question_count === 0}
                className="btn btn-primary"
                title={q.question_count === 0 ? "Add questions to this quiz before hosting." : ""}
              >
                {busyId === q.id ? <><span className="spinner" /> Starting…</> : <><Play size={14} /> Host live</>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
