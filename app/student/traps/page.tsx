"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Crosshair, ArrowLeft, AlertOctagon, History } from "lucide-react";

// =============================================================================
// DISTRACTOR TRAP DETECTOR — personal trap profile.
// Shows which examiner traps the student falls for most often, plus a recent
// log of every trap they've fallen for.
// =============================================================================

const TRAP_DESCRIPTIONS: Record<string, string> = {
  unit_confusion:        "Computed in one unit but the answer wanted another.",
  sign_error:            "Missed or added a negative sign / direction.",
  not_misread:           "Missed the word NOT or EXCEPT in the question.",
  off_by_one:            "Index, count, or boundary off by one.",
  plausible_formula:     "Used a related but wrong formula.",
  partial_application:   "Did most of the work but skipped one step.",
  mismatched_units:      "Forgot to convert before comparing options.",
  distractor_close_value:"Picked an option numerically close to the correct one.",
  definition_swap:       "Confused two related concepts.",
  other:                 "Doesn't match a clean trap pattern.",
};

type TrapRow = {
  id: string;
  topic: string | null;
  trap_type: string;
  trap_label: string;
  detail: string;
  created_at: string;
};

export default function TrapsPage() {
  const [list, setList] = useState<TrapRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data } = await sb
      .from("distractor_traps")
      .select("id, topic, trap_type, trap_label, detail, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);
    setList((data as unknown as TrapRow[]) || []);
    setLoading(false);
  }

  // Aggregate counts per trap_type for the profile cards.
  const profile = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of list) counts[t.trap_type] = (counts[t.trap_type] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [list]);

  const total = list.length;
  const topTrap = profile[0] ?? null;

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-rose-100 text-rose-700 p-3 shrink-0">
          <Crosshair size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Distractor Trap Detector</h1>
          <p className="muted mt-1">
            Examiners design wrong options with predictable psychological traps. Here&apos;s your personal trap
            profile — the patterns you fall for most often.
          </p>
        </div>
      </div>

      {/* Top stat strip */}
      <div className="grid sm:grid-cols-3 gap-3 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Traps logged</div>
          <div className="text-3xl font-bold">{total}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Your top trap</div>
          <div className="text-base font-bold mt-0.5">
            {topTrap ? topTrap[0].replace(/_/g, " ") : "—"}
          </div>
          {topTrap && <div className="text-xs muted mt-0.5">{topTrap[1]} time{topTrap[1] === 1 ? "" : "s"}</div>}
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Trap types seen</div>
          <div className="text-3xl font-bold">{profile.length}</div>
        </div>
      </div>

      <h2 className="h2 mt-8 mb-3">Your trap profile</h2>
      {loading ? (
        <div className="grid place-items-center py-10"><div className="spinner" /></div>
      ) : profile.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-4xl mb-2">🎯</div>
          <h3 className="font-semibold">No traps logged yet</h3>
          <p className="text-sm muted mt-1 max-w-md mx-auto">
            Take a quiz, miss some questions, then hit <strong>Find my traps</strong> on the results page.
            Every trap you fall for will appear here so you stop falling for them.
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {profile.map(([type, n]) => (
            <div key={type} className="card flex items-start gap-3">
              <div className="rounded-lg bg-rose-100 text-rose-700 p-2 shrink-0">
                <AlertOctagon size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold capitalize">{type.replace(/_/g, " ")}</div>
                <div className="text-xs muted mt-0.5">{TRAP_DESCRIPTIONS[type] || ""}</div>
                <div className="text-xs mt-2">
                  <strong className="text-rose-700">{n}</strong>
                  <span className="muted"> time{n === 1 ? "" : "s"}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Recent traps
      </h2>
      {list.length === 0 ? (
        <div className="card text-center py-6 muted text-sm">No history yet.</div>
      ) : (
        <div className="space-y-2">
          {list.slice(0, 20).map((t) => (
            <div key={t.id} className="card flex items-start gap-3">
              <div className="text-rose-600 mt-0.5 shrink-0"><AlertOctagon size={14} /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="badge bg-rose-100 text-rose-800">{t.trap_label}</span>
                  {t.topic && <span className="badge bg-slate-100 text-slate-700">{t.topic}</span>}
                  <span className="muted ml-auto">{new Date(t.created_at).toLocaleDateString()}</span>
                </div>
                <p className="text-sm text-slate-900 mt-1">{t.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
