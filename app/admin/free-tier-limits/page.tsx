"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  ArrowLeft, Save, Loader2, Settings, Clock, Infinity as InfinityIcon, AlertCircle, CheckCircle2,
} from "lucide-react";

// =============================================================================
// PLATFORM ADMIN: Free-tier limits editor
// -----------------------------------------------------------------------------
// One form, one save button. Every cap below is read live by the server-side
// quota helpers (lib/freeQuota.ts) on the next request — so saves here take
// effect within ~60 seconds (cache TTL) without redeploying.
//
// Three buckets:
//   1) DAILY caps — per-day usage on AI-burning routes. Reset at the
//      configured timezone's midnight (default Asia/Kolkata).
//   2) LIFETIME caps — once-per-user-ever for premium-plus features
//      (the "taste before you upgrade" set).
//   3) Reset window — timezone string used for daily resets.
//
// Set any cap to 0 to HARD-LOCK that feature on the Free tier
// (no taste at all). Use this when you want a feature behind a paywall
// without removing the dashboard tile.
// =============================================================================

type LimitsRow = Record<string, unknown> & {
  daily_reset_timezone: string;
  free_daily_attempts: number;
  free_trial_days: number;
};

type Schema = {
  daily: Array<{ surface: string; column: string }>;
  lifetime: Array<{ feature: string; column: string }>;
  extras: readonly string[];
};

// Pretty labels for the form. Source-of-truth lives in lib/freeQuota.ts —
// these are duplicated here because the page is client-side and we don't
// want to ship the server-only quota lib to the browser bundle.
const DAILY_LABEL: Record<string, { title: string; sub: string }> = {
  tutor_chat:    { title: "AI Tutor turns",        sub: "Per day. Each /api/tutor/chat reply counts as one." },
  teach_back:    { title: "Teach-Back submissions",sub: "Per day. Each graded explanation counts as one." },
  speed_session: { title: "Speed-Accuracy sessions",sub: "Per day. Each /api/speed/start counts as one." },
  flashcards:    { title: "Flashcard generations", sub: "Per day. Each batch of cards counts as one." },
  student_coach: { title: "Performance Coach turns",sub: "Per day. Each Coach reply counts as one." },
  daily_drill:   { title: "Daily Drill sessions",  sub: "Per day. Independent students only." },
};
const LIFETIME_LABEL: Record<string, { title: string; sub: string }> = {
  xray:             { title: "Past-Paper X-Ray",   sub: "How many X-rays a Free user can run, ever." },
  rank:             { title: "Mock Rank Predictor",sub: "Lifetime predictions on the Free plan." },
  visualizer:       { title: "Concept Visualizer", sub: "Lifetime animated explainers on Free." },
  voice_teacher:    { title: "Voice AI Teacher",   sub: "Lifetime voice sessions on Free." },
  trap_detector:    { title: "Trap Detector",      sub: "Lifetime trap diagnoses on Free." },
  knowledge_graph:  { title: "Knowledge Graph",    sub: "Lifetime fresh graph builds on Free." },
  bloom_score:      { title: "BloomIQ Score",      sub: "Lifetime calibrations on Free. Set to 1 so every new user gets it once." },
};

const TZ_OPTIONS = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "UTC",
  "America/New_York",
  "Europe/London",
];

export default function FreeTierLimitsPage() {
  const [limits, setLimits] = useState<LimitsRow | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [draft, setDraft] = useState<Record<string, number | string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Sign in required.");
      const r = await fetch("/api/admin/free-tier-limits", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to load limits");
      setLimits(j.limits as LimitsRow);
      setSchema(j.schema as Schema);
      // Seed the draft with the loaded row so unchanged fields don't reset.
      const seed: Record<string, number | string> = {};
      for (const k of Object.keys(j.limits)) {
        seed[k] = (j.limits as Record<string, unknown>)[k] as number | string;
      }
      setDraft(seed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!schema || !limits) return;
    setSaving(true);
    setErr(null);
    setOkMsg(null);
    try {
      // Send only changed fields — small bodies + per-field validation.
      const changes: Record<string, number | string> = {};
      for (const k of Object.keys(draft)) {
        if (draft[k] !== (limits as Record<string, unknown>)[k]) {
          changes[k] = draft[k];
        }
      }
      if (Object.keys(changes).length === 0) {
        setOkMsg("No changes to save.");
        return;
      }
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Sign in required.");
      const r = await fetch("/api/admin/free-tier-limits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(changes),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed");
      setLimits(j.limits as LimitsRow);
      setOkMsg(`Saved. Updated: ${(j.updated as string[]).join(", ")}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function setField(col: string, raw: string) {
    if (col === "daily_reset_timezone") {
      setDraft((d) => ({ ...d, [col]: raw }));
    } else {
      const n = raw === "" ? 0 : Number(raw);
      setDraft((d) => ({ ...d, [col]: Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : 0 }));
    }
  }

  return (
    <div className="max-w-4xl mx-auto fade-in p-6">
      <Link href="/admin/plans" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to plans
      </Link>

      <div className="flex items-start gap-3 mb-6">
        <div className="rounded-xl bg-indigo-100 text-indigo-700 p-3 shrink-0">
          <Settings size={22} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Free-tier limits</h1>
          <p className="text-sm text-slate-600 mt-1 max-w-prose">
            Every cap here is read live by the server. Saves take effect within ~60 seconds. Set any cap to <strong>0</strong> to hard-lock that feature on Free (paid users are always uncapped).
          </p>
        </div>
      </div>

      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}
      {okMsg && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> {okMsg}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-slate-600">
          <Loader2 className="animate-spin" size={16} /> Loading current limits…
        </div>
      )}

      {!loading && limits && schema && (
        <>
          {/* FREE TRIAL DURATION — the outer bound. After this many days a
              new independent student is locked out and shown the upgrade
              prompt. The daily + lifetime caps below apply DURING this trial. */}
          <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-5 mb-5">
            <h2 className="font-semibold mb-1">Free trial duration</h2>
            <p className="text-xs text-slate-700 mb-4">
              How many days a new independent student gets the Free plan before being locked out and prompted to upgrade. The daily + lifetime caps below apply <em>during</em> this trial window. Set to <strong>0</strong> for a permanent Free plan (no time limit). Max 90 days.
            </p>
            <CapField
              label="Trial length (days)"
              sub="0 = permanent free plan. 7 is the default."
              col="free_trial_days"
              value={Number(draft.free_trial_days ?? 7)}
              onChange={setField}
            />
          </section>

          {/* DAILY CAPS */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5">
            <div className="flex items-center gap-2 mb-1">
              <Clock size={16} className="text-slate-500" />
              <h2 className="font-semibold">Daily caps</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Resets at midnight in the timezone below. Counters are stored per (user, surface, day_key).
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CapField
                label="Quiz attempts / day"
                sub="Existing free_daily_attempts. Enforced by DB trigger on quiz_attempts."
                col="free_daily_attempts"
                value={Number(draft.free_daily_attempts ?? 0)}
                onChange={setField}
              />
              {schema.daily.map((d) => (
                <CapField
                  key={d.column}
                  label={DAILY_LABEL[d.surface]?.title || d.column}
                  sub={DAILY_LABEL[d.surface]?.sub || ""}
                  col={d.column}
                  value={Number(draft[d.column] ?? 0)}
                  onChange={setField}
                />
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-slate-100">
              <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                Daily reset timezone
              </label>
              <select
                value={String(draft.daily_reset_timezone ?? "Asia/Kolkata")}
                onChange={(e) => setField("daily_reset_timezone", e.target.value)}
                className="mt-1 block w-full md:w-72 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {TZ_OPTIONS.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
              <p className="text-xs text-slate-500 mt-1">Default Asia/Kolkata. Friendlier reset boundary for Indian students than UTC.</p>
            </div>
          </section>

          {/* LIFETIME CAPS */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5">
            <div className="flex items-center gap-2 mb-1">
              <InfinityIcon size={16} className="text-slate-500" />
              <h2 className="font-semibold">Lifetime caps (Free users only)</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              One-shot taste of premium-plus features. Once a Free user uses the feature this many times, they hit a paywall. Recommended: <strong>1</strong> for each.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {schema.lifetime.map((l) => (
                <CapField
                  key={l.column}
                  label={LIFETIME_LABEL[l.feature]?.title || l.column}
                  sub={LIFETIME_LABEL[l.feature]?.sub || ""}
                  col={l.column}
                  value={Number(draft[l.column] ?? 0)}
                  onChange={setField}
                />
              ))}
            </div>
          </section>

          {/* SAVE BAR */}
          <div className="sticky bottom-3 mt-6 flex items-center justify-end gap-3 rounded-xl border border-slate-200 bg-white/95 backdrop-blur px-4 py-3 shadow-sm">
            <button
              type="button"
              className="text-sm rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50"
              onClick={() => void load()}
              disabled={saving}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-md bg-emerald-600 text-white px-4 py-2 hover:bg-emerald-700 disabled:opacity-60"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? <><Loader2 className="animate-spin" size={14} /> Saving…</> : <><Save size={14} /> Save changes</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapField — one row of the editor. Number input plus a friendly description.
// ---------------------------------------------------------------------------
function CapField({
  label, sub, col, value, onChange,
}: {
  label: string;
  sub: string;
  col: string;
  value: number;
  onChange: (col: string, raw: string) => void;
}) {
  return (
    <label className="block">
      <div className="text-sm font-semibold text-slate-800">{label}</div>
      <div className="text-xs text-slate-500 mb-1.5">{sub}</div>
      <input
        type="number"
        min={0}
        max={1000}
        step={1}
        value={value}
        onChange={(e) => onChange(col, e.target.value)}
        className="block w-32 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono"
      />
    </label>
  );
}
