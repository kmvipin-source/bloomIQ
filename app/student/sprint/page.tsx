"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  CalendarDays, Flame, Trophy, Target, ArrowLeft, ArrowRight, Loader2,
  CheckCircle2, Sparkles, Settings as SettingsIcon, Trash2,
} from "lucide-react";

// =============================================================================
// EXAM SPRINT MODE — countdown + adaptive daily mission.
// Setup state if no exam is configured. Otherwise: big countdown banner +
// "Today's mission" card with 3 phase-tuned deep links + a simple 7-day
// adherence pill. The mission auto-recomputes each day based on date alone.
// =============================================================================

type ExamType = "JEE_MAIN" | "NEET" | "CAT" | "CUSTOM";

type Settings = {
  exam_type: ExamType;
  exam_label: string | null;
  exam_date: string;
  target_air: number | null;
  exam_name: string;
};

type MissionTask = { kind: string; title: string; href: string; done: boolean };
type Mission = {
  phase: "foundation" | "practice" | "sprint" | "final_week" | "past";
  phase_label: string;
  blurb: string;
  tasks: MissionTask[];
};

type SprintResp = {
  configured: boolean;
  settings: Settings | null;
  days_remaining: number;
  mission: Mission;
  days_done_this_week: number;
};

const EXAM_OPTIONS: Array<{ value: ExamType; label: string }> = [
  { value: "JEE_MAIN", label: "JEE Main" },
  { value: "NEET",     label: "NEET" },
  { value: "CAT",      label: "CAT" },
  { value: "CUSTOM",   label: "Other / custom" },
];

function todayIso(): string { return new Date().toISOString().slice(0, 10); }

export default function SprintPage() {
  const [loading, setLoading] = useState(true);
  const [resp, setResp] = useState<SprintResp | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Setup form state
  const [examType, setExamType] = useState<ExamType>("JEE_MAIN");
  const [examLabel, setExamLabel] = useState("");
  const [examDate, setExamDate] = useState(todayIso());
  const [targetAir, setTargetAir] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setLoading(false); return; }
      const r = await fetch("/api/sprint/today", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to load");
      setResp(j as SprintResp);
      // Pre-fill the form when we have settings (so "Edit" shows current values).
      if (j.settings) {
        setExamType(j.settings.exam_type);
        setExamLabel(j.settings.exam_label || "");
        setExamDate(j.settings.exam_date);
        setTargetAir(j.settings.target_air ? String(j.settings.target_air) : "");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setErr(null);
    if (examType === "CUSTOM" && !examLabel.trim()) {
      setErr("Give your custom exam a short label (e.g. 'Class 12 Boards').");
      return;
    }
    if (!examDate) {
      setErr("Pick the exam date.");
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/sprint/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          exam_type: examType,
          exam_label: examType === "CUSTOM" ? examLabel.trim() : null,
          exam_date: examDate,
          target_air: targetAir.trim() ? Number(targetAir) : null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed");
      setEditMode(false);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearSprint() {
    if (!window.confirm("Stop tracking this exam? You can set up another anytime.")) return;
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      await fetch("/api/sprint/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ clear: true }),
      });
      setResp((prev) => prev ? { ...prev, configured: false, settings: null } : prev);
      setEditMode(false);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  // Decide what view to show. If user has no settings OR they hit "edit", show form.
  const showSetup = !resp?.configured || editMode;

  if (showSetup) {
    return (
      <div className="max-w-2xl mx-auto fade-in">
        <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>

        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-emerald-100 text-emerald-700 p-3 shrink-0">
            <CalendarDays size={22} />
          </div>
          <div className="flex-1">
            <h1 className="h1">{resp?.configured ? "Edit your exam" : "Set up Exam Sprint"}</h1>
            <p className="muted mt-1">
              Tell us when your exam is and we&apos;ll give you a daily mission tuned to how far out it is —
              foundation work today, sprint mode as the date approaches, revision-only in the final week.
            </p>
          </div>
        </div>

        <div className="card mt-6 space-y-4">
          <div>
            <label className="label">Exam</label>
            <div className="grid sm:grid-cols-4 gap-2">
              {EXAM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setExamType(opt.value)}
                  className={`btn ${examType === opt.value ? "btn-primary" : "btn-secondary"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {examType === "CUSTOM" && (
            <div>
              <label className="label">Exam name</label>
              <input
                className="input"
                placeholder="e.g. Class 12 Boards · Olympiad · CLAT"
                value={examLabel}
                onChange={(e) => setExamLabel(e.target.value)}
                maxLength={80}
              />
            </div>
          )}

          <div>
            <label className="label">Exam date</label>
            <input
              type="date"
              className="input"
              value={examDate}
              onChange={(e) => setExamDate(e.target.value)}
              min={todayIso()}
            />
          </div>

          <div>
            <label className="label">Target rank <span className="muted text-xs font-normal">(optional)</span></label>
            <input
              className="input"
              inputMode="numeric"
              placeholder="e.g. 5000"
              value={targetAir}
              onChange={(e) => setTargetAir(e.target.value)}
            />
            <p className="text-xs muted mt-1">Plays into Mock Rank Predictor recommendations later.</p>
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
          )}

          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? <><Loader2 className="animate-spin" size={16} /> Saving…</> : <><Sparkles size={16} /> {resp?.configured ? "Update" : "Start sprint"}</>}
            </button>
            {resp?.configured && (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => { setEditMode(false); setErr(null); }}>
                  Cancel
                </button>
                <button type="button" className="btn btn-ghost text-red-700 ml-auto" onClick={clearSprint} disabled={busy}>
                  <Trash2 size={14} /> Stop tracking
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Configured view: countdown + mission.
  if (!resp?.settings) return null;
  const days = resp.days_remaining;
  const examName = resp.settings.exam_name;

  // Color tier driven by phase.
  const phaseAccent =
    resp.mission.phase === "final_week" ? "from-red-500 to-rose-600 text-white" :
    resp.mission.phase === "sprint"     ? "from-orange-500 to-amber-500 text-white" :
    resp.mission.phase === "practice"   ? "from-emerald-500 to-emerald-700 text-white" :
    resp.mission.phase === "past"       ? "from-slate-400 to-slate-500 text-white" :
                                          "from-sky-500 to-emerald-500 text-white";

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      {/* COUNTDOWN BANNER */}
      <div className={`rounded-2xl bg-gradient-to-br ${phaseAccent} p-6`}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide opacity-80 font-semibold">{resp.mission.phase_label}</div>
            <div className="mt-1">
              {days >= 0 ? (
                <>
                  <span className="text-5xl font-bold">{days}</span>
                  <span className="text-2xl ml-2 opacity-90">days</span>
                  <span className="ml-3 text-base opacity-90">to {examName}</span>
                </>
              ) : (
                <>
                  <span className="text-3xl font-bold">{Math.abs(days)} days ago</span>
                  <span className="ml-3 text-base opacity-90">— {examName} has passed</span>
                </>
              )}
            </div>
            <div className="text-sm opacity-90 mt-2">
              Exam date: {new Date(resp.settings.exam_date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
              {resp.settings.target_air && (
                <span className="ml-3 inline-flex items-center gap-1"><Target size={12} /> Target AIR ~{resp.settings.target_air.toLocaleString()}</span>
              )}
            </div>
          </div>
          <button type="button"
            onClick={() => setEditMode(true)}
            className="bg-white/20 hover:bg-white/30 text-white text-sm font-semibold rounded-lg px-3 py-2 inline-flex items-center gap-2"
          >
            <SettingsIcon size={14} /> Edit
          </button>
        </div>
      </div>

      {/* PHASE BLURB */}
      <div className="mt-4 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-700">
        {resp.mission.blurb}
      </div>

      {/* TODAY'S MISSION */}
      {resp.mission.tasks.length > 0 && (
        <div className="card mt-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-semibold text-lg">Today&apos;s mission</h2>
            <span className="text-xs muted inline-flex items-center gap-1">
              <Flame size={12} className="text-orange-500" />
              <strong className="text-slate-900">{resp.days_done_this_week}</strong>/7 days active this week
            </span>
          </div>
          <p className="text-xs muted mt-1 mb-4">
            Three small things. Tap one. Each item auto-checks when you&apos;ve actually done it today.
          </p>

          <div className="space-y-2">
            {resp.mission.tasks.map((t) => (
              <Link
                key={t.kind}
                href={t.href}
                className={`flex items-center gap-3 rounded-lg border px-3 py-3 transition ${
                  t.done
                    ? "bg-emerald-50 border-emerald-300"
                    : "bg-white border-slate-200 hover:border-emerald-300"
                }`}
              >
                <span className={`shrink-0 w-6 h-6 rounded-full grid place-items-center ${
                  t.done ? "bg-emerald-600 text-white" : "border-2 border-slate-300"
                }`}>
                  {t.done && <CheckCircle2 size={14} />}
                </span>
                <span className={`flex-1 text-sm ${t.done ? "line-through text-slate-500" : "text-slate-900 font-medium"}`}>
                  {t.title}
                </span>
                {!t.done && <ArrowRight size={14} className="text-slate-400 shrink-0" />}
              </Link>
            ))}
          </div>

          {resp.mission.tasks.every((t) => t.done) && (
            <div className="mt-4 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800 inline-flex items-center gap-2">
              <Trophy size={14} /> All three done today. Rest tonight, sharp tomorrow.
            </div>
          )}
        </div>
      )}

      {/* PAST EXAM HELPER */}
      {resp.mission.phase === "past" && (
        <div className="card mt-4 text-center py-6">
          <p className="text-sm text-slate-700">
            Got another attempt or a new exam? Tap <strong>Edit</strong> above to update the date.
          </p>
        </div>
      )}
    </div>
  );
}
