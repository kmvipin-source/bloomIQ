"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Quiz, Class } from "@/lib/types";
import Empty from "@/components/Empty";
import { Copy, Plus, Send, Users } from "lucide-react";
import AssignTestModal, { type ClassWithMembers } from "@/components/AssignTestModal";

/**
 * /teacher/quizzes — Your tests list.
 *
 * Two enhancements layered on top of the original simple list:
 *
 *   1. Each row shows a status pill:
 *        - amber "Unassigned" if the test has zero assignments
 *        - emerald "Assigned to N" otherwise
 *      so the teacher's eye lands on tests that still need to go out.
 *
 *   2. Each row has an inline "Assign" button that opens the shared
 *      AssignTestModal in place — no need to navigate into the test
 *      detail page just to assign.
 *
 * The whole-row Link still works for "view details"; the inline
 * buttons stop propagation to avoid double-navigation.
 */

type Row = Quiz & {
  question_count: number;
  attempt_count: number;
  assignment_count: number;
};

export default function QuizzesPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [classes, setClasses] = useState<ClassWithMembers[]>([]);
  const [loading, setLoading] = useState(true);

  // Which quiz, if any, currently has the assign modal open.
  const [assigningQuizId, setAssigningQuizId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data: quizzes } = await sb
      .from("quizzes")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });

    const enriched = await Promise.all(
      (quizzes || []).map(async (q: Quiz) => {
        const [{ count: qc }, { count: ac }, { count: asc }] = await Promise.all([
          sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", q.id),
          sb.from("quiz_attempts").select("id", { count: "exact", head: true }).eq("quiz_id", q.id),
          sb.from("quiz_assignments").select("id", { count: "exact", head: true }).eq("quiz_id", q.id),
        ]);
        return {
          ...q,
          question_count: qc || 0,
          attempt_count: ac || 0,
          assignment_count: asc || 0,
        };
      })
    );
    setItems(enriched);

    // Load classes (with members) once for the inline Assign modal.
    const { data: cts } = await sb
      .from("class_teachers")
      .select("class:classes(*)")
      .eq("teacher_id", user.id);
    type CtRow = { class: Class | null };
    const classList = ((cts as unknown as CtRow[]) || [])
      .map((r) => r.class)
      .filter((c): c is Class => c !== null)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const enrichedClasses: ClassWithMembers[] = await Promise.all(
      classList.map(async (c) => {
        const { data: mem } = await sb
          .from("class_members")
          .select("profile:profiles!class_members_student_id_fkey(id, full_name)")
          .eq("class_id", c.id);
        type MemRow = { profile: { id: string; full_name: string | null } | null };
        const members = ((mem as unknown as MemRow[]) || [])
          .filter((m) => m.profile)
          .map((m) => ({ id: m.profile!.id, full_name: m.profile!.full_name }));
        return { ...c, members };
      })
    );
    setClasses(enrichedClasses);

    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
  }

  // Quick top-of-page sense of how many tests are still to be sent out.
  const unassignedCount = useMemo(
    () => items.filter((q) => q.assignment_count === 0).length,
    [items],
  );

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="h1">Build &amp; assign tests</h1>
          <p className="muted mt-1 text-sm">
            Pick approved questions from your bank, build a test, and assign it to a class.
          </p>
          <p className="muted mt-2 text-xs">
            {items.length} {items.length === 1 ? "test" : "tests"} so far
            {unassignedCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-700">
                · <span>{unassignedCount} unassigned</span>
              </span>
            )}
          </p>
        </div>
        <Link
          href="/teacher/quizzes/new"
          className="btn btn-primary text-base px-5 py-2.5 shadow-sm shrink-0"
          title="Build a new test from your approved question library"
        >
          <Plus size={18} /> Create new test
        </Link>
      </div>

      {items.length === 0 ? (
        // Empty state previously had a duplicate CTA. The header above
        // already exposes a primary "Create new test" button always
        // visible on the same screen — duplicating it added clutter.
        <Empty
          icon="📝"
          title="No tests yet"
          body="Create a test from your approved questions to get a code you can share with students — use the Create new test button above."
        />
      ) : (
        <div className="grid gap-3 mt-6">
          {items.map((q) => {
            const unassigned = q.assignment_count === 0;
            return (
              <Link
                key={q.id}
                href={`/teacher/quizzes/${q.id}`}
                className="card card-hover flex items-center justify-between gap-3 flex-wrap"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900">{q.name}</span>
                    {unassigned ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300">
                        Unassigned
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-300">
                        Assigned · {q.assignment_count}
                      </span>
                    )}
                  </div>
                  <div className="text-xs muted mt-1">
                    {q.question_count} questions · {q.time_limit_minutes} min · {q.attempt_count} attempts
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-sm px-3 py-1.5 bg-slate-100 rounded font-mono">{q.code}</code>
                  <button type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyCode(q.code); }}
                    className="btn btn-ghost"
                    title="Copy code"
                    aria-label="Copy test code"
                  >
                    <Copy size={16} />
                  </button>
                  {classes.length > 0 ? (
                    <button type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setAssigningQuizId(q.id);
                      }}
                      className={`btn ${unassigned ? "btn-primary" : "btn-secondary"} text-sm`}
                      title={
                        unassigned
                          ? "Assign this test to a class or specific students"
                          : "Add another assignment — push this test to a different class, specific students, or with a new due date"
                      }
                    >
                      <Send size={14} /> {unassigned ? "Assign" : "Assign more"}
                    </button>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {classes.length === 0 && items.length > 0 && (
        <div className="mt-6 text-sm text-slate-700 bg-amber-50/60 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
          <Users size={14} className="text-amber-700" />
          You don&apos;t have any classes yet — create one to start assigning tests.
          <Link href="/teacher/classes" className="text-emerald-700 font-semibold hover:underline ml-auto">
            Manage classes →
          </Link>
        </div>
      )}

      {/* Shared Assign modal — opens for whichever test the teacher clicked. */}
      {assigningQuizId && (
        <AssignTestModal
          quizId={assigningQuizId}
          classes={classes}
          onClose={() => setAssigningQuizId(null)}
          onAssigned={() => { setAssigningQuizId(null); load(); }}
        />
      )}
    </div>
  );
}
