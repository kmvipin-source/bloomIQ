"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { GraduationCap, ArrowRight } from "lucide-react";

/**
 * StudentGoalPicker
 *
 * A single-question onboarding card shown on /student the first time an
 * independent student lands there (profiles.exam_goal is null). The chosen
 * goal drives tile prioritisation on the dashboard — a JEE aspirant sees
 * Sprint + Trap Detector + Rank Predictor up top, a Class 10 board student
 * sees Teach-Back + Misconception + Memory.
 *
 * Why ask this and not infer from grade?
 *   - A Class 12 student could be prepping JEE, NEET, CAT, or just boards.
 *     Grade alone is ambiguous. The goal disambiguates.
 *   - It sets explicit expectations — the student picks a path, the app
 *     promises to focus on it. That's a stronger commitment than
 *     auto-inferring.
 *
 * The picker is dismissable via the "Just exploring" option, which still
 * persists a value (so it doesn't keep showing). Users can change later
 * via the goal chip on the dashboard.
 */

export const STUDENT_GOALS = [
  { id: "class_10_boards", label: "Class 10 boards",     emoji: "📘", sub: "CBSE, ICSE, state boards" },
  { id: "class_12_boards", label: "Class 12 boards",     emoji: "📗", sub: "CBSE, ICSE, state boards" },
  { id: "jee_prep",        label: "JEE prep",            emoji: "🛠️", sub: "Engineering entrance" },
  { id: "neet_prep",       label: "NEET prep",           emoji: "🩺", sub: "Medical entrance" },
  { id: "cat_prep",        label: "CAT prep",            emoji: "🎯", sub: "MBA entrance" },
  { id: "upsc_prep",       label: "UPSC prep",           emoji: "🏛️", sub: "Civil services" },
  { id: "bank_exams",      label: "Bank exams",          emoji: "🏦", sub: "IBPS, SBI, RBI, etc." },
  { id: "exploring",       label: "Just exploring",      emoji: "🌱", sub: "Self-study, no specific exam" },
] as const;

export type StudentGoalId = typeof STUDENT_GOALS[number]["id"];

export default function StudentGoalPicker({
  onPicked,
}: {
  onPicked: (goal: StudentGoalId) => void;
}) {
  const [picking, setPicking] = useState<StudentGoalId | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(goal: StudentGoalId) {
    setErr(null);
    setPicking(goal);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const { error } = await sb
        .from("profiles")
        .update({
          exam_goal: goal,
          exam_goal_set_at: new Date().toISOString(),
        })
        .eq("id", user.id);
      if (error) throw error;
      onPicked(goal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save your goal.");
      setPicking(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto fade-in">
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <GraduationCap size={22} className="text-emerald-700" />
          <h1 className="text-xl font-bold">What are you preparing for?</h1>
        </div>
        <p className="text-sm text-slate-600 mb-5">
          We&apos;ll tune your dashboard to the tools that matter most for your goal.
          You can change this later.
        </p>

        <div className="grid sm:grid-cols-2 gap-2">
          {STUDENT_GOALS.map((g) => (
            <button
              key={g.id}
              type="button"
              disabled={picking !== null}
              onClick={() => pick(g.id)}
              className={`flex items-start gap-3 p-3 rounded-lg border text-left transition ${
                picking === g.id
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/40"
              } disabled:cursor-wait disabled:opacity-60`}
            >
              <span className="text-2xl shrink-0">{g.emoji}</span>
              <span className="flex-1">
                <span className="font-semibold text-sm block">{g.label}</span>
                <span className="text-xs text-slate-600 block mt-0.5">{g.sub}</span>
              </span>
              {picking === g.id ? (
                <span className="spinner" />
              ) : (
                <ArrowRight size={14} className="text-slate-400 mt-1.5 shrink-0" />
              )}
            </button>
          ))}
        </div>

        {err && (
          <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            {err}
          </div>
        )}

        <p className="text-xs muted mt-5">
          Tip: pick the closest match. You can switch later from the chip at the top of your dashboard.
        </p>
      </div>
    </div>
  );
}
