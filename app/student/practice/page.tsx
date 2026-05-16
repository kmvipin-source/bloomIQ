"use client";

// =============================================================================
// app/student/practice/page.tsx
// -----------------------------------------------------------------------------
// Adaptive Personalised Practice — entry point.
//
// The student types a topic, hits "Start practice", and we POST to
// /api/student/adaptive-practice. The API picks their weakest Bloom level
// from the last-30-day mastery snapshot, generates 5 calibrated MCQs, and
// returns { quizCode, targetedLevel }. We show a quick "Targeting <Level>"
// preview, then redirect into the existing quiz-taking flow at
// /student/quiz/{code}.
// =============================================================================
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_META, type BloomLevel, isBloomLevel } from "@/lib/bloom";
import { Target, Sparkles, Play, Zap } from "lucide-react";
import CurrentGoalChip from "@/components/CurrentGoalChip";
import MarkingSchemePicker from "@/components/MarkingSchemePicker";
import { type MarkingScheme } from "@/lib/scoring";
import { suggestPresetForGoal, type ScoringPresetKey } from "@/lib/scoringPresets";
import { suggestedTopics, placeholderTopic } from "@/lib/topicSuggestions";
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";

type StartResponse = {
  ok: true;
  quizId: string;
  quizCode: string;
  targetedLevel: BloomLevel;
  targetedLevelLabel: string;
  total: number;
  verification: {
    verified: number;
    disputed: number;
    verified_pct: number;
  };
};

export default function StudentPracticePage() {
  const router = useRouter();

  const search = useSearchParams();
  // Deep-link from ZCORIQ Bloom Score active-path Start buttons:
  // /student/practice?bloom=evaluate&topic=core+syllabus
  const deepLinkBloom: BloomLevel | null = (() => {
    const raw = search.get("bloom");
    return raw && isBloomLevel(raw) ? (raw as BloomLevel) : null;
  })();
  const deepLinkTopic = search.get("topic") || "";

  const [topic, setTopic] = useState(deepLinkTopic || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<StartResponse | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);

  // Learning context + sticky marking scheme — same pattern as Speed
  // Trainer / Generate. Pulls profile.exam_goal + learner_profile +
  // last_marking_scheme on mount and feeds the topic chips, the
  // placeholder, and the marking-scheme picker.
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  const [markingScheme, setMarkingScheme] = useState<MarkingScheme | null>(null);
  const [suggestedPreset, setSuggestedPreset] = useState<ScoringPresetKey>("PRACTICE");

  // Light auth check on mount so we can show a sensible message instead of
  // a 401 fetch error after the form submit.
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      setAuthed(!!user);
      if (!user) return;
      // Same fetch shape as the Speed Trainer + Generate pages.
      try {
        const { data: prof } = await sb
          .from("profiles")
          .select("exam_goal, learner_profile, last_marking_scheme")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as {
          exam_goal: string | null;
          learner_profile: string | null;
          last_marking_scheme: unknown | null;
        } | null;
        if (row?.exam_goal) setExamGoal(row.exam_goal);
        const lp = row?.learner_profile;
        if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
          setLearnerProfile(lp);
        }
        setSuggestedPreset(suggestPresetForGoal(row?.exam_goal ?? null));
        if (row?.last_marking_scheme && typeof row.last_marking_scheme === "object") {
          setMarkingScheme(row.last_marking_scheme as MarkingScheme);
        }
      } catch { /* silent — chips fall back to generic */ }
    })();
  }, []);

  // Auto-fire when arriving via the ZCORIQ Bloom Score active-path Start buttons.
  // Triggered when the URL carries a bloom param AND either a topic param or
  // the explicit auto=1 flag. We fire ONCE per page-load; the autoFiredRef
  // guard prevents StrictMode double-effect or any re-render loop. The form
  // never appears for these users — straight from "Building your X drill..."
  // to /student/quiz/[code].
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (authed === null) return; // wait for auth check
    if (!authed) return;
    if (autoFiredRef.current) return;
    if (!deepLinkBloom) return;
    const wantsAuto = search.get("auto") === "1" || (deepLinkTopic && deepLinkTopic.length >= 2);
    if (!wantsAuto) return;
    autoFiredRef.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  async function start() {
    setErr(null);
    // When deep-linked, fall back to a sensible default topic so the student
    // doesn't have to type. They can still edit the field and re-Start.
    const fallbackTopic = deepLinkBloom ? "core syllabus" : "";
    const t = (topic.trim() || fallbackTopic).trim();
    if (t.length < 2) {
      // Use a goal-aware example so the error message itself matches
      // the user's register. suggestedTopics() always returns a
      // non-empty array (k12 default), so the || fallback is dead code
      // but kept defensive in case the helper is ever changed.
      const example = suggestedTopics(examGoal, learnerProfile)[0] || "your topic";
      setErr(`Tell us what you want to practise (e.g. ${example}).`);
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("You're signed out — sign in to practise.");

      const res = await fetch("/api/student/adaptive-practice", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          topic: t,
          ...(deepLinkBloom ? { target_bloom: deepLinkBloom } : {}),
          // Per-quiz marking scheme — persists onto quizzes.marking_scheme
          // on the API side so the resulting quiz scores against it. The
          // server also writes profile.last_marking_scheme on success so
          // every future surface pre-fills with the same pick.
          markingScheme,
        }),
      });
      const data = (await res.json()) as Partial<StartResponse> & { error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Couldn't build your practice set.");
      }
      const safeLevel: BloomLevel = isBloomLevel(String(data.targetedLevel))
        ? (data.targetedLevel as BloomLevel)
        : "understand";
      const finalResult: StartResponse = {
        ok: true,
        quizId: String(data.quizId),
        quizCode: String(data.quizCode),
        targetedLevel: safeLevel,
        targetedLevelLabel: data.targetedLevelLabel || BLOOM_META[safeLevel].label,
        total: data.total ?? 5,
        verification: data.verification || { verified: 0, disputed: 0, verified_pct: 0 },
      };
      setResult(finalResult);
      // Brief pause so the student sees what level we're targeting, then
      // hand off to the existing quiz-taking flow.
      window.setTimeout(() => {
        router.push(`/student/quiz/${finalResult.quizCode}`);
      }, 1400);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto fade-in">
      {deepLinkBloom ? (
        <div className="card mb-4 p-3 border-2"
             style={{ borderColor: "#10b981", background: "rgba(16,185,129,0.08)" }}>
          <div className="flex items-start gap-2 text-sm">
            <Zap size={16} style={{ color: "#10b981" }} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold" style={{ color: "#10b981" }}>
                Drilling your <strong>{BLOOM_META[deepLinkBloom].label}</strong> weak spot from your ZCORIQ active path
              </div>
              <p className="text-xs opacity-80 mt-0.5">
                {deepLinkTopic
                  ? <>Drilling: <strong>{deepLinkTopic}</strong>. Edit the topic below if you want a different focus, or tap Start.</>
                  : "Type a topic to drill, or tap Start for the default at this Bloom level."}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-emerald-100 text-emerald-700 p-2.5">
            <Target size={22} />
          </div>
          <div>
            <h1 className="h1">Adaptive Practice</h1>
            <p className="muted mt-0.5">{deepLinkBloom ? `Targeting ${BLOOM_META[deepLinkBloom].label} level.` : "Questions targeted to your level."}</p>
          </div>
        </div>
        <CurrentGoalChip />
      </div>

      {/* "Today's focus" — preview before submit, full result after. */}
      {!result && (
        <div className="card mt-6 bg-emerald-50/50 border-emerald-100">
          <div className="text-xs uppercase tracking-wide font-semibold text-emerald-800">
            Today&apos;s focus
          </div>
          <p className="mt-1 text-slate-700">
            Tell us what you want to practise. We&apos;ll pick the right
            difficulty for you &mdash; 5 questions, calibrated to your
            current level. We use your ZCORIQ Bloom Score and any recent quiz
            attempts to find your sweet spot; new students get a balanced
            mid-difficulty set.
          </p>
        </div>
      )}

      {result && (
        <div
          className="card mt-6 border-2"
          style={{
            borderColor: BLOOM_META[result.targetedLevel].color,
            backgroundColor: `${BLOOM_META[result.targetedLevel].color}15`,
          }}
        >
          <div className="text-xs uppercase tracking-wide font-semibold text-slate-700">
            Today&apos;s focus
          </div>
          <div className="mt-1 text-2xl font-bold" style={{ color: BLOOM_META[result.targetedLevel].color }}>
            Targeting {result.targetedLevelLabel}
          </div>
          <p className="mt-1 text-sm text-slate-700">
            {BLOOM_META[result.targetedLevel].description} {result.total} questions ready —
            taking you in now…
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="spinner" />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => router.push(`/student/quiz/${result.quizCode}`)}
            >
              <Play size={16} /> Start now
            </button>
          </div>
        </div>
      )}

      {/* Form */}
      {!result && (
        <div className="card mt-4 space-y-4">
          <div>
            <label className="label">What do you want to practise?</label>
            <input
              className="input"
              placeholder={placeholderTopic(examGoal, learnerProfile)}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) start();
              }}
              disabled={busy}
              maxLength={200}
            />
            {/* Goal-aware suggested topics — tap to fill. Replaces the
                old hardcoded "Photosynthesis" example that was wrong for
                CAT / corporate / UPSC learners. */}
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
            <p className="text-xs muted mt-2">
              Be specific — &ldquo;Photosynthesis&rdquo; works better than &ldquo;Biology&rdquo;.
            </p>
          </div>

          {/* Marking scheme — sticky pre-fill from profile.last_marking_scheme. */}
          <div>
            <label className="label">Marking scheme</label>
            <MarkingSchemePicker
              value={markingScheme}
              onChange={setMarkingScheme}
              suggested={suggestedPreset}
            />
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
              {err}
            </div>
          )}

          {authed === false && (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              You need to be signed in as a student to use Adaptive Practice.
            </div>
          )}

          <div className="flex justify-end">
            <button type="button"
              className="btn btn-primary"
              onClick={start}
              disabled={busy || authed === false}
            >
              {busy ? (
                <>
                  <span className="spinner" /> Building your set… (10–20s)
                </>
              ) : (
                <>
                  <Sparkles size={16} /> Start practice
                </>
              )}
            </button>
          </div>

          <p className="text-xs muted text-center">
            We&apos;ll figure out the right Bloom level (Remember → Create) from
            your recent attempts, then write 5 questions just for you.
          </p>
        </div>
      )}
    </div>
  );
}
