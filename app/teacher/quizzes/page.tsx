"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Quiz } from "@/lib/types";
import Empty from "@/components/Empty";
import { Copy, Plus } from "lucide-react";

export default function QuizzesPage() {
  const [items, setItems] = useState<(Quiz & { question_count: number; attempt_count: number })[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data: quizzes } = await sb
      .from("quizzes")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    const enriched = await Promise.all(
      (quizzes || []).map(async (q: Quiz) => {
        const [{ count: qc }, { count: ac }] = await Promise.all([
          sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", q.id),
          sb.from("quiz_attempts").select("id", { count: "exact", head: true }).eq("quiz_id", q.id),
        ]);
        return { ...q, question_count: qc || 0, attempt_count: ac || 0 };
      })
    );
    setItems(enriched);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">Your quizzes</h1>
          <p className="muted mt-1">{items.length} total</p>
        </div>
        <Link href="/teacher/quizzes/new" className="btn btn-primary"><Plus size={16} /> New quiz</Link>
      </div>

      {items.length === 0 ? (
        <Empty
          icon="📝"
          title="No quizzes yet"
          body="Create a quiz from your approved questions to get a code you can share with students."
          action={<Link href="/teacher/quizzes/new" className="btn btn-primary">Create your first quiz</Link>}
        />
      ) : (
        <div className="grid gap-3 mt-6">
          {items.map((q) => (
            <Link key={q.id} href={`/teacher/quizzes/${q.id}`} className="card card-hover flex items-center justify-between">
              <div>
                <div className="font-semibold text-slate-900">{q.name}</div>
                <div className="text-xs muted mt-1">
                  {q.question_count} questions · {q.time_limit_minutes} min · {q.attempt_count} attempts
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="text-sm px-3 py-1.5 bg-slate-100 rounded font-mono">{q.code}</code>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyCode(q.code); }}
                  className="btn btn-ghost"
                  title="Copy code"
                >
                  <Copy size={16} />
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
