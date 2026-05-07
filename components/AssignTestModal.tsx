"use client";

import { useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Class, QuizAssignment } from "@/lib/types";
import { X } from "lucide-react";

/**
 * AssignTestModal — shared Assign-test UI used in three places:
 *
 *   1. /teacher/quizzes/[id]   — assign the test you're currently viewing
 *   2. /teacher/quizzes        — inline Assign button on each row of the list
 *   3. /teacher/assign         — quick-assign workflow page (pick test first)
 *
 * Why a shared component: until this extraction, the assign logic lived
 * only on the detail page. Adding "assign from list" or "quick assign"
 * surfaces meant either copy-pasting (with the inevitable behavior
 * drift) or pulling everything into one place. Picked the latter.
 *
 * Behaviour matches the previous inline modal exactly: due date is
 * mandatory, must be in the future; whole-class vs. specific-student
 * scope; duplicate-assignment confirm prompt; same supabase insert
 * shape.
 */

export type ClassWithMembers = Class & {
  members: { id: string; full_name: string | null }[];
};

type Props = {
  quizId: string;
  /** Pre-loaded list of classes the teacher can assign to. */
  classes: ClassWithMembers[];
  /** Existing assignments for THIS quiz, so we can warn on duplicates. */
  existingAssignments?: Pick<QuizAssignment, "id" | "class_id" | "student_id">[];
  /** Called when the modal should close (X, cancel, after success). */
  onClose: () => void;
  /** Called after a successful insert so the parent can refresh its lists. */
  onAssigned?: () => void;
};

export default function AssignTestModal({
  quizId,
  classes,
  existingAssignments = [],
  onClose,
  onAssigned,
}: Props) {
  const [pickedClassId, setPickedClassId] = useState<string>("");
  const [scope, setScope] = useState<"whole" | "specific">("whole");
  const [pickedStudents, setPickedStudents] = useState<Set<string>>(new Set());
  const [dueAt, setDueAt] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickedClass = useMemo(
    () => classes.find((c) => c.id === pickedClassId) || null,
    [classes, pickedClassId],
  );

  function toggleStudent(sid: string) {
    setPickedStudents((s) => {
      const n = new Set(s);
      if (n.has(sid)) n.delete(sid); else n.add(sid);
      return n;
    });
  }

  async function save() {
    setErr(null);
    if (!pickedClassId) return setErr("Pick a class first.");
    if (scope === "specific" && pickedStudents.size === 0) {
      return setErr("Select at least one student, or switch to whole-class.");
    }
    if (!dueAt) return setErr("Pick a due date and time.");
    const dueMs = Date.parse(dueAt);
    if (Number.isNaN(dueMs) || dueMs <= Date.now()) {
      return setErr("Due date must be in the future.");
    }

    // Duplicate-assignment guard. Same logic the inline modal had.
    const dupes = scope === "whole"
      ? existingAssignments.filter((a) => a.class_id === pickedClassId)
      : existingAssignments.filter((a) => a.student_id !== null && pickedStudents.has(a.student_id));
    if (dupes.length > 0) {
      const who = scope === "whole"
        ? `the class "${pickedClass?.name || ""}"`
        : `${dupes.length} student${dupes.length === 1 ? "" : "s"}`;
      const ok = window.confirm(
        `This test is already assigned to ${who}. Assign again with the new due date?`,
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const due_at = new Date(dueMs).toISOString();
      const rows = scope === "whole"
        ? [{ quiz_id: quizId, class_id: pickedClassId, student_id: null, assigned_by: user.id, due_at }]
        : Array.from(pickedStudents).map((sid) => ({
            quiz_id: quizId, class_id: null, student_id: sid, assigned_by: user.id, due_at,
          }));

      const { error } = await sb.from("quiz_assignments").insert(rows);
      if (error) throw error;
      onAssigned?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not assign");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 grid place-items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card max-w-lg w-full overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 2rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="h2">Assign test</h3>
          <button onClick={onClose} className="btn btn-ghost" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <label className="label">Class</label>
        <select
          className="select"
          value={pickedClassId}
          onChange={(e) => { setPickedClassId(e.target.value); setPickedStudents(new Set()); }}
        >
          <option value="">— Pick a class —</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.members.length} student{c.members.length === 1 ? "" : "s"})
            </option>
          ))}
        </select>

        {pickedClass && (
          <>
            <label className="label mt-4">Who in {pickedClass.name}?</label>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                className={`btn ${scope === "whole" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setScope("whole")}
              >
                Entire class ({pickedClass.members.length})
              </button>
              <button
                type="button"
                className={`btn ${scope === "specific" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setScope("specific")}
                disabled={pickedClass.members.length === 0}
              >
                Specific students
              </button>
            </div>

            {scope === "specific" && (
              pickedClass.members.length === 0 ? (
                <div className="text-sm muted">This class has no members yet.</div>
              ) : (
                <div className="border border-slate-200 rounded-lg max-h-56 overflow-y-auto divide-y divide-slate-100">
                  {pickedClass.members.map((m) => {
                    const on = pickedStudents.has(m.id);
                    return (
                      <label
                        key={m.id}
                        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleStudent(m.id)}
                          className="h-4 w-4 accent-emerald-600"
                        />
                        <span className="text-sm">{m.full_name || "Unknown student"}</span>
                      </label>
                    );
                  })}
                </div>
              )
            )}
          </>
        )}

        <label className="label mt-4">
          Due date &amp; time <span className="text-red-600">*</span>
        </label>
        <input
          type="datetime-local"
          className="input"
          required
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
        />

        {err && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? <><span className="spinner" /> Assigning…</> : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}
