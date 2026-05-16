"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { CalendarDays, Sparkles, TrendingUp, Award, BookOpen } from "lucide-react";

// =============================================================================
// PARENT READ-ONLY DASHBOARD — token-authed, no login.
//
// Note on the dynamic segment name: this folder is named `[studentId]` for
// historical reasons (it pre-existed as a stale stub). The value of the
// segment is actually the OPAQUE TOKEN issued from /api/parent/invite, not a
// user id. The student-facing link generator already uses `/parent/<token>`
// URLs, so the path is correct — we just read the param under whatever name
// Next gives us and pass it as `token` to the API.
// =============================================================================

type BloomItem = { correct: number; total: number; pct: number; label: string; color: string };
type Attempt = { id: string; quiz_name: string; score: number; total: number; pct: number; submitted_at: string | null };

type Resp = {
  student: { name: string; grade: string | null; school: string | null };
  parent_label: string | null;
  stats: { this_week_completed: number; last_30_days_completed: number; avg_score: number };
  bloom_breakdown: Record<string, BloomItem>;
  top_topics: Array<{ topic: string; count: number }>;
  sprint: { exam_name: string; exam_date: string; days_remaining: number } | null;
  recent_attempts: Attempt[];
};

export default function ParentDashboardPage() {
  // The dynamic segment name is `studentId` for legacy reasons but the value
  // is the token from /api/parent/invite.
  const params = useParams<{ studentId: string }>();
  const token = params?.studentId || "";

  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); setErr("Missing token in URL."); return; }
    (async () => {
      try {
        const r = await fetch(`/api/parent/data?token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Could not load dashboard");
        setData(j as Resp);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load dashboard");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) {
    return <div className="grid place-items-center py-32"><div className="spinner" /></div>;
  }

  if (err || !data) {
    return (
      <div className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-rose-50 via-white to-emerald-50">
        <div className="max-w-md card text-center">
          <div className="text-4xl mb-2">📭</div>
          <h1 className="font-bold text-lg">Link unavailable</h1>
          <p className="text-sm muted mt-2">{err || "This link could not be opened."}</p>
          <p className="text-xs muted mt-2">If you got this from your child, ask them to generate a new one.</p>
        </div>
      </div>
    );
  }

  const stats = data.stats;
  const bloomEntries = Object.entries(data.bloom_breakdown);
  const greeting = data.parent_label ? `Hi, ${data.parent_label}` : "Hi";
  const childFirstName = data.student.name.split(" ")[0];

  return (
    <main className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      <header className="border-b border-slate-200/60 bg-white/70 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">ZCORIQ</span>
          </Link>
          <div className="text-xs muted">Parent view · read-only</div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8 fade-in">
        <div className="text-sm muted">{greeting}</div>
        <h1 className="h1 mt-1">{childFirstName}&apos;s progress</h1>
        <p className="muted mt-1 text-sm">
          {data.student.grade && <span>Grade {data.student.grade}</span>}
          {data.student.grade && data.student.school && <span> · </span>}
          {data.student.school && <span>{data.student.school}</span>}
        </p>

        {/* Sprint banner */}
        {data.sprint && data.sprint.days_remaining >= 0 && (
          <div className={`mt-4 rounded-xl border-2 px-4 py-3 ${
            data.sprint.days_remaining < 7
              ? "border-red-300 bg-red-50 text-red-900"
              : data.sprint.days_remaining < 30
              ? "border-orange-300 bg-orange-50 text-orange-900"
              : "border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}>
            <div className="flex items-center gap-3 flex-wrap">
              <CalendarDays size={20} />
              <div>
                <strong className="text-2xl">{data.sprint.days_remaining} days</strong>
                <span className="ml-2">to {data.sprint.exam_name}</span>
                <div className="text-xs opacity-80 mt-0.5">
                  Exam date: {new Date(data.sprint.exam_date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Top stats */}
        <div className="grid sm:grid-cols-3 gap-4 mt-6">
          <div className="card">
            <div className="text-xs muted uppercase font-semibold inline-flex items-center gap-1">
              <Sparkles size={12} /> This week
            </div>
            <div className="text-3xl font-bold mt-1">{stats.this_week_completed}</div>
            <div className="text-xs muted">tests completed</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold inline-flex items-center gap-1">
              <BookOpen size={12} /> Last 30 days
            </div>
            <div className="text-3xl font-bold mt-1">{stats.last_30_days_completed}</div>
            <div className="text-xs muted">tests completed</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold inline-flex items-center gap-1">
              <Award size={12} /> Average score
            </div>
            <div className="text-3xl font-bold mt-1">{stats.avg_score > 0 ? `${stats.avg_score}%` : "—"}</div>
            <div className="text-xs muted">across last 30 days</div>
          </div>
        </div>

        {/* Bloom mastery */}
        {bloomEntries.length > 0 && (
          <div className="card mt-6">
            <h2 className="font-semibold flex items-center gap-2">
              <TrendingUp size={18} /> Thinking-level breakdown
            </h2>
            <p className="text-xs muted mt-1 mb-3">
              ZCORIQ scores every question by the kind of thinking it tests. Higher levels = deeper understanding.
            </p>
            <div className="space-y-2">
              {bloomEntries.map(([lvl, b]) => (
                <div key={lvl}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium">{b.label}</span>
                    <span className="muted">{b.correct} of {b.total} correct ({b.pct}%)</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full transition-all" style={{ width: `${b.pct}%`, backgroundColor: b.color }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top topics */}
        {data.top_topics.length > 0 && (
          <div className="card mt-4">
            <h2 className="font-semibold">Topics they&apos;ve been studying</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {data.top_topics.map((t) => (
                <span key={t.topic} className="badge bg-slate-100 text-slate-700">
                  {t.topic} <span className="ml-1 text-slate-500">×{t.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Recent attempts */}
        {data.recent_attempts.length > 0 && (
          <div className="card mt-4 overflow-x-auto p-0">
            <div className="px-5 pt-4 pb-2 font-semibold">Recent tests</div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase muted">
                <tr>
                  <th className="px-4 py-3 text-left">Test</th>
                  <th className="px-4 py-3 text-left">Score</th>
                  <th className="px-4 py-3 text-left">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recent_attempts.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-medium">{a.quiz_name}</td>
                    <td className="px-4 py-3">
                      <strong>{a.score}/{a.total}</strong> <span className="muted">({a.pct}%)</span>
                    </td>
                    <td className="px-4 py-3 muted">
                      {a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {data.recent_attempts.length === 0 && (
          <div className="card mt-4 text-center py-8 muted text-sm">
            No tests taken yet. {childFirstName} will start showing up here once they begin practicing.
          </div>
        )}

        <p className="text-xs muted text-center mt-10">
          This is a read-only view of {childFirstName}&apos;s ZCORIQ progress, shared by them.
          {childFirstName} can revoke this link anytime.
        </p>
      </div>
    </main>
  );
}
