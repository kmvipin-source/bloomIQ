"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_META, isBloomLevel, type BloomLevel } from "@/lib/bloom";
import {
  Search, AlertOctagon, CheckCircle2, RotateCcw, Sparkles, ArrowLeft, Loader2,
} from "lucide-react";

// =============================================================================
// MISCONCEPTION DETECTIVE — personal ledger of every diagnosed wrong-answer
// pattern, with strikes, resolved-state, and a "Drill this" button that
// instantly generates a 3-question micro-quiz.
// =============================================================================

type Misc = {
  id: string;
  topic: string | null;
  bloom_level: string | null;
  label: string;
  detail: string;
  strikes: number;
  resolved: boolean;
  first_seen_at: string;
  last_seen_at: string;
};

export default function MisconceptionsPage() {
  const router = useRouter();
  const [list, setList] = useState<Misc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data } = await sb
      .from("misconceptions")
      .select("*")
      .eq("user_id", user.id)
      .order("last_seen_at", { ascending: false });
    setList((data as unknown as Misc[]) || []);
    setLoading(false);
  }

  async function drill(m: Misc) {
    setErr(null);
    setBusy(m.id);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/misconception/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ misconception_id: m.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Drill creation failed");
      router.push(`/student/quiz/${j.quizCode}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Drill creation failed");
      setBusy(null);
    }
  }

  async function toggleResolved(m: Misc) {
    setBusy(m.id);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      await fetch("/api/misconception/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ misconception_id: m.id, resolved: !m.resolved }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const visible = list.filter((m) => showResolved || !m.resolved);
  const activeCount = list.filter((m) => !m.resolved).length;
  const repeatCount = list.filter((m) => !m.resolved && m.strikes >= 3).length;

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 text-amber-700 p-3 shrink-0">
          <Search size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Misconception Detective</h1>
          <p className="muted mt-1">
            Every time you got an MCQ wrong, we asked the AI <em>why</em>. The specific mental error is listed
            below. Hit <strong>Drill this</strong> for a 3-question micro-quiz built to break it.
          </p>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid sm:grid-cols-3 gap-3 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Active</div>
          <div className="text-3xl font-bold">{activeCount}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Recurring (3+ strikes)</div>
          <div className={`text-3xl font-bold ${repeatCount > 0 ? "text-red-600" : ""}`}>{repeatCount}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Resolved</div>
          <div className="text-3xl font-bold text-emerald-700">{list.length - activeCount}</div>
        </div>
      </div>

      {err && (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
      )}

      <div className="flex items-center justify-between mt-6 mb-3">
        <h2 className="h2">Your ledger</h2>
        <label className="text-xs flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {loading ? (
        <div className="grid place-items-center py-10"><div className="spinner" /></div>
      ) : visible.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-4xl mb-2">🕵️</div>
          <h3 className="font-semibold">Nothing diagnosed yet</h3>
          <p className="text-sm muted mt-1 max-w-md mx-auto">
            After you finish a quiz, hit <strong>Diagnose my mistakes</strong> on the results page and your
            misconceptions will land here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((m) => {
            const recurring = !m.resolved && m.strikes >= 3;
            const bloomLevel: BloomLevel | null =
              m.bloom_level && isBloomLevel(m.bloom_level) ? m.bloom_level : null;
            return (
              <div
                key={m.id}
                className={`card flex items-start gap-4 flex-wrap border-l-4 ${
                  m.resolved
                    ? "opacity-70 border-emerald-300"
                    : recurring
                    ? "border-red-400 bg-red-50/30"
                    : "border-amber-300"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {m.resolved ? (
                      <span className="badge badge-approved inline-flex items-center gap-1">
                        <CheckCircle2 size={11} /> Resolved
                      </span>
                    ) : recurring ? (
                      <span className="badge inline-flex items-center gap-1 bg-red-100 text-red-800">
                        <AlertOctagon size={11} /> {m.strikes} strikes
                      </span>
                    ) : (
                      <span className="badge badge-pending">{m.strikes} strike{m.strikes === 1 ? "" : "s"}</span>
                    )}
                    {m.topic && (
                      <span className="badge bg-slate-100 text-slate-700">{m.topic}</span>
                    )}
                    {bloomLevel && (
                      <span className={`badge badge-${bloomLevel}`}>{BLOOM_META[bloomLevel].label}</span>
                    )}
                  </div>
                  <p className="mt-2 text-slate-900 font-medium">{m.detail}</p>
                  <p className="text-xs muted mt-1">
                    First seen {new Date(m.first_seen_at).toLocaleDateString()} · last seen {new Date(m.last_seen_at).toLocaleDateString()}
                  </p>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {!m.resolved && (
                    <button type="button"
                      className="btn btn-primary"
                      onClick={() => drill(m)}
                      disabled={busy === m.id}
                    >
                      {busy === m.id ? <><Loader2 className="animate-spin" size={14} /> Building drill…</> : <><Sparkles size={14} /> Drill this</>}
                    </button>
                  )}
                  <button type="button"
                    className="btn btn-secondary"
                    onClick={() => toggleResolved(m)}
                    disabled={busy === m.id}
                  >
                    {m.resolved ? <><RotateCcw size={14} /> Reopen</> : <><CheckCircle2 size={14} /> Mark resolved</>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
