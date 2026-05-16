"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, Clock, Database, Key, Globe } from "lucide-react";

// =============================================================================
// /status — human-friendly view of /api/healthz
// -----------------------------------------------------------------------------
// /api/healthz returns raw JSON (for UptimeRobot / Checkly). This page hits
// the same endpoint and renders a clean status card so an operator can see
// app health at a glance without parsing JSON. Auto-refreshes every 30s.
// =============================================================================

type Checks = {
  env_supabase_url: "ok" | "missing";
  env_service_role: "ok" | "missing";
  db_read: "ok" | "fail";
};
type Health = {
  ok: boolean;
  ts: string;
  elapsed_ms: number;
  checks: Checks;
  error?: string;
};

const CHECK_META: Record<keyof Checks, { label: string; description: string; icon: React.ComponentType<{ size?: number }> }> = {
  env_supabase_url: {
    label: "Supabase URL",
    description: "NEXT_PUBLIC_SUPABASE_URL configured at build time.",
    icon: Globe,
  },
  env_service_role: {
    label: "Service role key",
    description: "SUPABASE_SERVICE_ROLE_KEY available at runtime.",
    icon: Key,
  },
  db_read: {
    label: "Database read",
    description: "Service-role client can query public.profiles.",
    icon: Database,
  },
};

function fmtTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString("en-IN", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  async function check() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/healthz", { cache: "no-store" });
      const j = await r.json() as Health;
      setHealth(j);
      setLastChecked(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to reach /api/healthz");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    check();
    const interval = window.setInterval(check, 30000);
    return () => window.clearInterval(interval);
  }, []);

  const status = health?.ok ? "operational" : health ? "degraded" : "unknown";
  const banner =
    status === "operational"
      ? { tone: "emerald", text: "All systems operational", Icon: CheckCircle2 }
      : status === "degraded"
      ? { tone: "rose", text: "System degraded", Icon: XCircle }
      : { tone: "slate", text: "Checking status…", Icon: AlertCircle };

  const TONE: Record<string, { bg: string; fg: string; ring: string; soft: string }> = {
    emerald: { bg: "#10b981", fg: "#ffffff", ring: "#34d399", soft: "#d1fae5" },
    rose:    { bg: "#e11d48", fg: "#ffffff", ring: "#fb7185", soft: "#ffe4e6" },
    slate:   { bg: "#64748b", fg: "#ffffff", ring: "#94a3b8", soft: "#f1f5f9" },
  };
  const tone = TONE[banner.tone];

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Branding */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-2xl">🌱</span>
          <span className="text-xl font-bold tracking-tight">ZCORIQ — System status</span>
        </div>

        {/* Banner */}
        <div
          className="rounded-2xl p-6 flex items-center gap-4 shadow-sm"
          style={{ background: tone.bg, color: tone.fg }}
        >
          <div
            className="w-12 h-12 rounded-full grid place-items-center shrink-0"
            style={{ background: "rgba(255,255,255,0.15)" }}
          >
            <banner.Icon size={28} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold">{banner.text}</div>
            <div className="text-xs opacity-90 mt-0.5">
              {health
                ? `Checked ${fmtTime(health.ts)} · responded in ${health.elapsed_ms} ms`
                : "Awaiting first check"}
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            style={{ background: "rgba(255,255,255,0.2)", color: tone.fg }}
            onClick={check}
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {/* Per-check rows */}
        <div className="mt-6 bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Service checks</h2>
            <span className="text-xs muted">Auto-refresh every 30 s</span>
          </div>
          {(Object.keys(CHECK_META) as Array<keyof Checks>).map((key) => {
            const meta = CHECK_META[key];
            const value = health?.checks?.[key];
            const isOk = value === "ok";
            const isUnknown = !health;
            const checkTone = isOk ? "emerald" : isUnknown ? "slate" : "rose";
            const t = TONE[checkTone];
            return (
              <div
                key={key}
                className="px-5 py-4 border-b border-slate-100 last:border-0 flex items-center gap-4"
              >
                <div
                  className="w-10 h-10 rounded-lg grid place-items-center shrink-0"
                  style={{ background: t.soft, color: t.bg }}
                >
                  <meta.icon size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm text-slate-900">{meta.label}</div>
                  <div className="text-xs muted mt-0.5">{meta.description}</div>
                </div>
                <span
                  className="text-[10px] uppercase tracking-wide font-bold rounded-full px-2.5 py-1 border"
                  style={{
                    background: t.soft,
                    color: t.bg,
                    borderColor: t.ring,
                  }}
                >
                  {isUnknown ? "Checking" : isOk ? "Operational" : "Down"}
                </span>
              </div>
            );
          })}
        </div>

        {/* Failure details */}
        {health && !health.ok && health.error && (
          <div className="mt-4 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-900">
            <div className="font-semibold mb-1 inline-flex items-center gap-1.5">
              <XCircle size={14} /> Last failure
            </div>
            <code className="text-xs break-all">{health.error}</code>
          </div>
        )}
        {err && (
          <div className="mt-4 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-900">
            Could not reach status endpoint — {err}
          </div>
        )}

        {/* Footer meta */}
        <div className="mt-6 flex items-center justify-between text-xs muted">
          <span className="inline-flex items-center gap-1.5">
            <Clock size={12} />
            {lastChecked
              ? `Last refresh: ${lastChecked.toLocaleTimeString("en-IN")}`
              : "Not yet refreshed"}
          </span>
          <a
            href="/api/healthz"
            className="font-mono text-[11px] hover:text-emerald-700"
            target="_blank"
            rel="noreferrer"
          >
            /api/healthz (raw JSON)
          </a>
        </div>
      </div>
    </main>
  );
}
