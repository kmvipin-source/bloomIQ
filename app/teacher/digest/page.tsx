"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Sparkles, AlertTriangle, CheckCircle2, RefreshCcw, ArrowLeft, AlertCircle,
} from "lucide-react";

// =============================================================================
// /teacher/digest — Weekly Teacher Brief
// -----------------------------------------------------------------------------
// One-shot view. On load it POSTs to /api/teacher/digest, which returns a
// structured digest (headline, issues, wins, actions) along with the snapshot
// timestamp. The Refresh button re-runs it. Skeleton on first load; red banner
// with retry on failure.
// =============================================================================

type Issue = {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
};
type Win = { title: string; detail: string };
type Action = {
  title: string;
  detail: string;
  when: "this_class" | "this_week" | "this_month";
};
type Digest = {
  headline: string;
  issues: Issue[];
  wins: Win[];
  actions: Action[];
};
type DigestResponse = {
  digest: Digest;
  asOf: string;
  snapshot: {
    classes: number;
    students: number;
    quizzes_owned: number;
    attempts_30d: number;
    avg_score_30d: number | null;
  };
};

function relativeFromNow(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs >= 1) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins >= 1) return `${mins}m ago`;
  return "just now";
}

export default function TeacherDigestPage() {
  const [data, setData] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Tick every 30s so the "Last refreshed Xm ago" indicator updates.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  async function fetchDigest(opts: { isRefresh?: boolean } = {}) {
    if (opts.isRefresh) setRefreshing(true);
    else setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("You're signed out — please log in again.");

      const res = await fetch("/api/teacher/digest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Brief request failed (${res.status}).`);
      setData(json as DigestResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not generate the brief.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchDigest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="max-w-4xl mx-auto fade-in">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Link href="/teacher" className="muted text-xs inline-flex items-center gap-1 hover:underline">
            <ArrowLeft size={12} /> Back to dashboard
          </Link>
          <h1 className="h1 flex items-center gap-2 mt-1">
            <Sparkles size={28} /> This Week
          </h1>
          <p className="muted mt-1">Your weekly classroom briefing.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {data?.asOf && (
            <span className="muted text-xs">
              Last refreshed {relativeFromNow(data.asOf)}
            </span>
          )}
          <button
            className="btn btn-secondary"
            onClick={() => fetchDigest({ isRefresh: true })}
            disabled={loading || refreshing}
            title="Re-run the brief"
          >
            {refreshing ? <span className="spinner" /> : <RefreshCcw size={14} />}
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {err && (
        <div className="mt-6 text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-lg flex items-start gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Couldn&rsquo;t generate the brief</div>
            <div className="text-xs mt-0.5">{err}</div>
          </div>
          <button
            className="btn btn-ghost text-xs"
            onClick={() => fetchDigest({ isRefresh: true })}
            disabled={refreshing}
          >
            Retry
          </button>
        </div>
      )}

      {/* Body */}
      {loading && !data ? (
        <Skeleton />
      ) : data ? (
        <DigestView digest={data.digest} />
      ) : null}
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function DigestView({ digest }: { digest: Digest }) {
  return (
    <div className="space-y-6 mt-6">
      {/* Headline */}
      <div className="card bg-gradient-to-br from-emerald-50 to-sky-50 border-emerald-200">
        <div className="text-xs muted uppercase tracking-wide font-semibold flex items-center gap-1">
          <Sparkles size={12} /> Headline
        </div>
        <p className="text-xl sm:text-2xl font-bold mt-2 leading-snug">
          {digest.headline || "No notable shifts this week."}
        </p>
      </div>

      {/* Issues */}
      <Section
        title="Issues to address"
        icon={<AlertTriangle size={18} className="text-red-600" />}
      >
        {digest.issues.length === 0 ? (
          <EmptyRow text="No issues flagged this week." />
        ) : (
          digest.issues.map((it, i) => (
            <div key={i} className="card-hover card flex items-start gap-3">
              <PriorityChip priority={it.priority} />
              <div className="flex-1">
                <div className="font-semibold">{it.title}</div>
                <div className="muted text-sm mt-1">{it.detail}</div>
              </div>
            </div>
          ))
        )}
      </Section>

      {/* Wins */}
      <Section
        title="Wins to celebrate"
        icon={<Sparkles size={18} className="text-emerald-600" />}
      >
        {digest.wins.length === 0 ? (
          <EmptyRow text="No wins highlighted this week." />
        ) : (
          digest.wins.map((w, i) => (
            <div key={i} className="card-hover card flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-emerald-500 mt-2 flex-shrink-0" />
              <div className="flex-1">
                <div className="font-semibold">{w.title}</div>
                <div className="muted text-sm mt-1">{w.detail}</div>
              </div>
            </div>
          ))
        )}
      </Section>

      {/* Actions */}
      <Section
        title="Suggested actions"
        icon={<CheckCircle2 size={18} className="text-sky-600" />}
      >
        {digest.actions.length === 0 ? (
          <EmptyRow text="No specific actions suggested this week." />
        ) : (
          digest.actions.map((a, i) => (
            <div key={i} className="card-hover card flex items-start gap-3">
              <WhenChip when={a.when} />
              <div className="flex-1">
                <div className="font-semibold">{a.title}</div>
                <div className="muted text-sm mt-1">{a.detail}</div>
              </div>
            </div>
          ))
        )}
      </Section>

      <p className="muted text-xs text-center pt-2">
        Generated by AI from your students&rsquo; last 30 days of data. Always verify before acting.
      </p>
    </div>
  );
}

function Section({
  title, icon, children,
}: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="h2 flex items-center gap-2 mb-3">
        {icon} {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="card text-sm muted text-center py-4">{text}</div>;
}

function PriorityChip({ priority }: { priority: "high" | "medium" | "low" }) {
  const map = {
    high:   "bg-red-100 text-red-800",
    medium: "bg-amber-100 text-amber-800",
    low:    "bg-slate-200 text-slate-800",
  } as const;
  const label = priority.charAt(0).toUpperCase() + priority.slice(1);
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 mt-0.5 ${map[priority]}`}>
      {label}
    </span>
  );
}

function WhenChip({ when }: { when: "this_class" | "this_week" | "this_month" }) {
  const map = {
    this_class: "bg-sky-100 text-sky-800",
    this_week:  "bg-emerald-100 text-emerald-800",
    this_month: "bg-slate-200 text-slate-800",
  } as const;
  const labelMap = {
    this_class: "This class",
    this_week:  "This week",
    this_month: "This month",
  } as const;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 mt-0.5 ${map[when]}`}>
      {labelMap[when]}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6 mt-6 animate-pulse">
      <div className="card h-28 bg-slate-100" />
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <div className="h-5 w-48 bg-slate-200 rounded mb-3" />
          <div className="space-y-2">
            <div className="card h-16 bg-slate-100" />
            <div className="card h-16 bg-slate-100" />
            <div className="card h-16 bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}
