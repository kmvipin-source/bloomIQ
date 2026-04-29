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
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_META, type BloomLevel, isBloomLevel } from "@/lib/bloom";
import { Target, Sparkles, Play } from "lucide-react";

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

  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<StartResponse | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);

  // Light auth check on mount so we can show a sensible message instead of
  // a 401 fetch error after the form submit.
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      setAuthed(!!user);
    })();
  }, []);

  async function start() {
    setErr(null);
    const t = topic.trim();
    if (t.length < 2) {
      setErr("Tell us what you want to practise (e.g. Photosynthesis).");
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
        body: JSON.stringify({ topic: t }),
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
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-emerald-100 text-emerald-700 p-2.5">
          <Target size={22} />
        </div>
        <div>
          <h1 className="h1">Adaptive Practice</h1>
          <p className="muted mt-0.5">Questions targeted to your level.</p>
        </div>
      </div>

      {/* "Today's focus" — preview before submit, full result after. */}
      {!result && (
        <div className="card mt-6 bg-emerald-50/50 border-emerald-100">
          <div className="text-xs uppercase tracking-wide font-semibold text-emerald-800">
            Today&apos;s focus
          </div>
          <p className="mt-1 text-slate-700">
            Tell us what you want to practise. We&apos;ll pick the right
            difficulty for you based on your last 30 days of attempts —
            5 questions, calibrated to where you&apos;ll grow most.
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
              placeholder="e.g. Photosynthesis, Quadratic equations, French Revolution"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) start();
              }}
              disabled={busy}
              maxLength={200}
            />
            <p className="text-xs muted mt-1">
              Be specific — &ldquo;Photosynthesis&rdquo; works better than &ldquo;Biology&rdquo;.
            </p>
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
            <button
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
