"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import {
  GraduationCap, Sparkles, MessageCircleQuestion, ArrowRight, History,
  CheckCircle2, AlertTriangle, Loader2, ArrowLeft,
} from "lucide-react";
import { suggestedTopics, placeholderTopic } from "@/lib/topicSuggestions";
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";
import CurrentGoalChip from "@/components/CurrentGoalChip";

// =============================================================================
// TEACH-BACK (Feynman) — student explains a topic in their own words and the
// AI grades it on Bloom's taxonomy, then asks a Socratic follow-up.
// =============================================================================

type Grade = {
  id: string;
  created_at: string;
  overall_score: number;
  bloom_scores: Record<BloomLevel, number>;
  strengths: string[];
  gaps: string[];
  follow_up_q: string;
};

type SessionRow = {
  id: string;
  topic: string;
  overall_score: number;
  bloom_scores: Record<BloomLevel, number>;
  created_at: string;
};

export default function TeachBackPage() {
  // ----- form state -----
  const [topic, setTopic] = useState("");
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ----- result state (drives the "graded" view) -----
  const [grade, setGrade] = useState<Grade | null>(null);
  const [followAnswer, setFollowAnswer] = useState("");
  const [followBusy, setFollowBusy] = useState(false);
  const [followVerdict, setFollowVerdict] = useState<string | null>(null);

  // ----- history -----
  const [history, setHistory] = useState<SessionRow[]>([]);

  // ----- learning-context-aware topic suggestions (2026-05-12) -----
  // Hardcoded "Photosynthesis" placeholder was wrong for CAT / NEET /
  // corporate learners. Pulls exam_goal + learner_profile from the
  // profile so the placeholder and the chip row both match the user's
  // register. User can change goal from the persistent chip below.
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);

  useEffect(() => {
    void loadHistory();
    void loadLearningContext();
  }, []);

  async function loadLearningContext() {
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: prof } = await sb
        .from("profiles")
        .select("exam_goal, learner_profile")
        .eq("id", user.id)
        .maybeSingle();
      const row = prof as { exam_goal: string | null; learner_profile: string | null } | null;
      if (row?.exam_goal) setExamGoal(row.exam_goal);
      const lp = row?.learner_profile;
      if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
        setLearnerProfile(lp);
      }
    } catch { /* silent — chips fall back to generic */ }
  }

  async function loadHistory() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb
      .from("teach_back_sessions")
      .select("id, topic, overall_score, bloom_scores, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setHistory((data as unknown as SessionRow[]) || []);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setGrade(null);
    setFollowVerdict(null);
    setFollowAnswer("");
    if (explanation.trim().length < 30) {
      setErr("Write at least a couple of sentences (30+ characters).");
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/teach-back/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ topic: topic.trim(), explanation: explanation.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Grading failed");
      setGrade(j as Grade);
      void loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Grading failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitFollowUp() {
    if (!grade || !followAnswer.trim()) return;
    setFollowBusy(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/teach-back/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ session_id: grade.id, answer: followAnswer.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Follow-up grading failed");
      setFollowVerdict(j.verdict as string);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Follow-up grading failed");
    } finally {
      setFollowBusy(false);
    }
  }

  function reset() {
    setGrade(null);
    setFollowVerdict(null);
    setFollowAnswer("");
    setExplanation("");
    setTopic("");
  }

  // Best Bloom level the student demonstrated this attempt — used in the result header.
  const peakLevel: BloomLevel | null = useMemo(() => {
    if (!grade) return null;
    let best: BloomLevel | null = null;
    let bestScore = -1;
    // Walk in ascending order so on ties we surface the *higher* Bloom level.
    for (const lvl of BLOOM_LEVELS) {
      const s = grade.bloom_scores[lvl] ?? 0;
      if (s >= bestScore) { best = lvl; bestScore = s; }
    }
    return bestScore > 0 ? best : null;
  }, [grade]);

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
        <CurrentGoalChip />
      </div>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-emerald-100 text-emerald-700 p-3 shrink-0">
          <GraduationCap size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Teach-Back</h1>
          <p className="muted mt-1">
            Pick a topic. Explain it in your own words like you&apos;re teaching a friend. We&apos;ll grade your
            explanation on Bloom&apos;s taxonomy and ask one sharp follow-up question.
          </p>
        </div>
      </div>

      {!grade && (
        <form onSubmit={submit} className="card mt-6 space-y-4">
          <div>
            <label className="label">Topic</label>
            <input
              className="input"
              placeholder={placeholderTopic(examGoal, learnerProfile)}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              required
              maxLength={200}
            />
            {/* Goal-aware topic chips — tap one to fill the input. Replaces
                the old hardcoded "Photosynthesis" example which read wrong
                for CAT / NEET / corporate learners. */}
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestedTopics(examGoal, learnerProfile).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTopic(t)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${
                    topic === t
                      ? "bg-emerald-100 border-emerald-300 text-emerald-800 font-semibold"
                      : "bg-white border-slate-200 text-slate-700 hover:border-emerald-300"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">
              Your explanation
              <span className="muted font-normal text-xs ml-2">— 2–6 sentences, your own words</span>
            </label>
            <textarea
              className="textarea min-h-[160px]"
              placeholder="Pretend a curious friend asked you to explain it. Don't paste from a textbook — say what *you* think it means and why it matters."
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              maxLength={4000}
              required
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs muted">The more honest you are, the better we can help.</p>
              <p className="text-xs muted">{explanation.length} / 4000</p>
            </div>
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
          )}

          <button className="btn btn-primary" disabled={busy || !topic.trim() || explanation.trim().length < 30}>
            {busy ? <><Loader2 className="animate-spin" size={16} /> Grading…</> : <><Sparkles size={16} /> Grade my explanation</>}
          </button>
        </form>
      )}

      {grade && (
        <div className="mt-6 space-y-4">
          {/* Overall score banner */}
          <div className="card bg-gradient-to-br from-emerald-50 to-sky-50 border-emerald-200">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide font-semibold text-emerald-700">Overall mastery</div>
                <div className="text-4xl font-bold mt-1">{grade.overall_score}<span className="text-lg muted">/100</span></div>
                {peakLevel && (
                  <div className="mt-2 text-sm text-slate-700">
                    Peak Bloom level: <span className={`badge badge-${peakLevel}`}>{BLOOM_META[peakLevel].label}</span>
                  </div>
                )}
              </div>
              <button className="btn btn-secondary" onClick={reset}>Try another topic</button>
            </div>
          </div>

          {/* Bloom scorecard */}
          <div className="card">
            <h3 className="font-semibold mb-3">Bloom-level breakdown</h3>
            <div className="space-y-2">
              {BLOOM_LEVELS.map((lvl) => {
                const s = grade.bloom_scores[lvl] ?? 0;
                const pct = (s / 5) * 100;
                return (
                  <div key={lvl}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium">{BLOOM_META[lvl].label}</span>
                      <span className="muted">{s} / 5</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: BLOOM_META[lvl].color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Strengths + gaps */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="card">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <h3 className="font-semibold">What you nailed</h3>
              </div>
              {grade.strengths.length === 0 ? (
                <p className="text-sm muted">Nothing strong stood out — try writing more next time.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {grade.strengths.map((s, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-emerald-600 mt-0.5">✓</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={16} className="text-amber-600" />
                <h3 className="font-semibold">Where you can grow</h3>
              </div>
              {grade.gaps.length === 0 ? (
                <p className="text-sm muted">No glaring gaps — well done.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {grade.gaps.map((g, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-amber-600 mt-0.5">!</span>
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Socratic follow-up */}
          {grade.follow_up_q && (
            <div className="card border-emerald-300 bg-emerald-50/40">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-white text-emerald-700 p-2 shrink-0 border border-emerald-200">
                  <MessageCircleQuestion size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs uppercase tracking-wide font-semibold text-emerald-800">Follow-up question</div>
                  <div className="font-medium text-slate-900 mt-1">{grade.follow_up_q}</div>

                  {!followVerdict && (
                    <div className="mt-3 space-y-2">
                      <textarea
                        className="textarea min-h-[100px] bg-white"
                        placeholder="Take a stab — even one or two sentences."
                        value={followAnswer}
                        onChange={(e) => setFollowAnswer(e.target.value)}
                        maxLength={2000}
                      />
                      <button
                        className="btn btn-primary"
                        onClick={submitFollowUp}
                        disabled={followBusy || followAnswer.trim().length < 5}
                      >
                        {followBusy ? <><Loader2 className="animate-spin" size={16} /> Checking…</> : <><ArrowRight size={16} /> Submit reply</>}
                      </button>
                    </div>
                  )}

                  {followVerdict && (
                    <div className="mt-3 rounded-lg bg-white border border-emerald-200 p-3 text-sm">
                      <div className="text-xs uppercase tracking-wide font-semibold text-emerald-700 mb-1">Teacher&apos;s note</div>
                      {followVerdict}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* History */}
      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Recent attempts
      </h2>
      {history.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No attempts yet — your first one will land here.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Topic</th>
                <th className="px-4 py-3 text-left">Mastery</th>
                <th className="px-4 py-3 text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{h.topic}</td>
                  <td className="px-4 py-3"><strong>{h.overall_score}</strong> <span className="muted">/100</span></td>
                  <td className="px-4 py-3 muted">{new Date(h.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
