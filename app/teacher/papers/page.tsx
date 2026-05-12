"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { ExamPaper } from "@/lib/types";
import Empty from "@/components/Empty";
import { FilePlus2, Printer, Pencil, CheckCircle2, FileText } from "lucide-react";

export default function PapersListPage() {
  const [papers, setPapers] = useState<ExamPaper[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data } = await sb.from("exam_papers").select("*").eq("owner_id", user.id).order("created_at", { ascending: false });
      setPapers((data as ExamPaper[]) || []);
    } finally {
      // Always clear the spinner so a missing user / RLS error doesn't
      // leave the page stuck on the loader (was a silent dead-end if
      // auth.getUser returned null).
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1 flex items-center gap-2"><FileText size={28} /> Exam papers</h1>
          <p className="muted mt-1">Generate printable question papers from a template. Edit, finalize, print — they don&apos;t go to students online.</p>
        </div>
        <Link href="/teacher/papers/new" className="btn btn-primary"><FilePlus2 size={16} /> New paper</Link>
      </div>

      {papers.length === 0 ? (
        // Empty state used to repeat the "Create paper" CTA, but the
        // header above already has a "New paper" button always visible —
        // duplicating it added clutter without changing reachability.
        <Empty
          icon="📄"
          title="No papers yet"
          body="Build your first printable question paper from a custom template — use the New paper button above."
        />
      ) : (
        <div className="grid gap-3 mt-6">
          {papers.map((p) => (
            // Card is a plain div — title is the explicit Link, Print is
            // a real <button> sibling. Previously the whole card was an
            // <a> with a <span onClick> inside, which was not keyboard-
            // reachable and produced invalid HTML.
            <div
              key={p.id}
              className="card card-hover flex items-start justify-between gap-4 flex-wrap"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/teacher/papers/${p.id}`}
                    className="font-semibold hover:underline"
                  >
                    {p.name}
                  </Link>
                  {p.status === "finalized" ? (
                    <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                      <CheckCircle2 size={10} /> Finalized
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                      <Pencil size={10} /> Draft
                    </span>
                  )}
                </div>
                <div className="text-xs muted mt-1 flex flex-wrap gap-x-3">
                  {p.subject && <span>{p.subject}</span>}
                  {p.class_grade && <span>{p.class_grade}</span>}
                  <span>{p.total_marks} marks</span>
                  {p.duration_minutes && <span>{p.duration_minutes} min</span>}
                  {p.exam_date && <span>{new Date(p.exam_date).toLocaleDateString()}</span>}
                  <span>Created {new Date(p.created_at).toLocaleDateString()}</span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary text-xs"
                onClick={() => window.open(`/teacher/papers/${p.id}/print`, "_blank")}
              >
                <Printer size={14} /> Print
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
