"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { TrendingUp, TrendingDown, Minus, Sparkles, Layers, Target, Zap, Flame } from "lucide-react";
import {
  ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LabelList, Cell,
} from "recharts";

type Answer = {
  attempt_id: string;
  bloom_level: BloomLevel;
  is_correct: boolean | null;
};
type AttemptMeta = {
  id: string; submitted_at: string | null; score: number; total: number; quiz_id: string;
};
type QuizMeta = { id: string; name: string; subject: string | null; topic_family: string | null };
type LevelStat = { level: BloomLevel; correct: number; total: number; pct: number; trend: number };
type FamilyStat = {
  family: string; subject: string | null; testCount: number; avgScore: number; trend: number;
  recentDate: string | null; series: { date: string; pct: number; id: string }[];
};

const UNCATEGORISED = "(uncategorised)";

export default function ProgressPage() {
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [attempts, setAttempts] = useState<AttemptMeta[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [quizMetas, setQuizMetas] = useState<Map<string, QuizMeta>>(new Map());

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: prof } = await sb.from("profiles").select("full_name").eq("id", user.id).single();
      setName(prof?.full_name || "");

      const { data: atts } = await sb
        .from("quiz_attempts")
        .select("id, submitted_at, score, total, quiz_id")
        .eq("student_id", user.id)
        .not("submitted_at", "is", null)
        .order("submitted_at", { ascending: true });
      const attemptList = ((atts as AttemptMeta[]) || []);
      setAttempts(attemptList);

      const attemptIds = attemptList.map((a) => a.id);
      if (attemptIds.length === 0) { setLoading(false); return; }

      const { data: ans } = await sb
        .from("attempt_answers")
        .select("attempt_id, bloom_level, is_correct")
        .in("attempt_id", attemptIds);
      setAnswers((ans as Answer[]) || []);

      const quizIds = Array.from(new Set(attemptList.map((a) => a.quiz_id)));
      const { data: quizzes } = await sb
        .from("quizzes")
        .select("id, name, subject, topic_family")
        .in("id", quizIds);
      const m = new Map<string, QuizMeta>();
      ((quizzes as QuizMeta[]) || []).forEach((q) => m.set(q.id, q));
      setQuizMetas(m);

      setLoading(false);
    })();
  }, []);

  const levelStats: LevelStat[] = useMemo(() => {
    if (answers.length === 0) return [];
    const orderById = new Map(attempts.map((a, i) => [a.id, i]));
    const sorted = [...answers].sort(
      (a, b) => (orderById.get(a.attempt_id) || 0) - (orderById.get(b.attempt_id) || 0)
    );
    const out: LevelStat[] = [];
    BLOOM_LEVELS.forEach((lvl) => {
      const forLvl = sorted.filter((a) => a.bloom_level === lvl);
      if (forLvl.length === 0) return;
      const correct = forLvl.filter((a) => a.is_correct).length;
      const total = forLvl.length;
      const half = Math.floor(total / 2);
      const prior = forLvl.slice(0, half);
      const recent = forLvl.slice(forLvl.length - half);
      const priorPct = prior.length ? (prior.filter((a) => a.is_correct).length / prior.length) * 100 : 0;
      const recentPct = recent.length ? (recent.filter((a) => a.is_correct).length / recent.length) * 100 : 0;
      const trend = total >= 4 ? Math.round(recentPct - priorPct) : 0;
      out.push({ level: lvl, correct, total, pct: Math.round((correct / total) * 100), trend });
    });
    return out;
  }, [answers, attempts]);

  const familyStats: FamilyStat[] = useMemo(() => {
    if (attempts.length === 0) return [];
    const groups = new Map<string, { subject: string | null; rows: { id: string; date: string; pct: number }[] }>();
    attempts.forEach((a) => {
      const meta = quizMetas.get(a.quiz_id);
      const family = meta?.topic_family || UNCATEGORISED;
      const subject = meta?.subject || null;
      const pct = a.total ? (a.score / a.total) * 100 : 0;
      const date = a.submitted_at || "";
      if (!groups.has(family)) groups.set(family, { subject, rows: [] });
      groups.get(family)!.rows.push({ id: a.id, date, pct });
    });
    return Array.from(groups, ([family, g]) => {
      const rows = g.rows.sort((a, b) => a.date.localeCompare(b.date));
      const half = Math.floor(rows.length / 2);
      const prior = rows.slice(0, half);
      const recent = rows.slice(rows.length - half);
      const priorAvg = prior.length ? prior.reduce((s, r) => s + r.pct, 0) / prior.length : 0;
      const recentAvg = recent.length ? recent.reduce((s, r) => s + r.pct, 0) / recent.length : 0;
      const trend = rows.length >= 2 ? Math.round(recentAvg - priorAvg) : 0;
      const avg = Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length);
      return {
        family, subject: g.subject, testCount: rows.length, avgScore: avg, trend,
        recentDate: rows[rows.length - 1]?.date || null,
        series: rows.map((r) => ({
          id: r.id,
          date: new Date(r.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          pct: Math.round(r.pct),
        })),
      };
    }).sort((a, b) => a.avgScore - b.avgScore); // weakest first so eyes go to focus areas
  }, [attempts, quizMetas]);

  // Headline numbers
  const overall = useMemo(() => {
    if (attempts.length === 0) return { taken: 0, avg: 0 };
    const avg = Math.round(
      attempts.reduce((s, a) => s + (a.total ? (a.score / a.total) * 100 : 0), 0) / attempts.length
    );
    return { taken: attempts.length, avg };
  }, [attempts]);

  // Top 2 weak Bloom levels (with at least 3 answers seen, to avoid noise).
  const weakBlooms = useMemo(() => {
    return levelStats.filter((l) => l.total >= 3 && l.pct < 70).slice(0, 2);
  }, [levelStats]);

  // Top 2 weak topics (avgScore < 70%, at least 1 attempt).
  const weakTopics = useMemo(() => {
    return familyStats.filter((f) => f.family !== UNCATEGORISED && f.avgScore < 70).slice(0, 2);
  }, [familyStats]);

  // Radar chart series: percent at each Bloom level. Levels with no data
  // show as 0 so the chart shape clearly reveals weak vs strong sides.
  const radarData = useMemo(() => {
    return BLOOM_LEVELS.map((l) => {
      const s = levelStats.find((x) => x.level === l);
      return {
        level: BLOOM_META[l].label,
        pct: s?.pct ?? 0,
        full: 100,
      };
    });
  }, [levelStats]);

  // Score-over-time timeline data.
  const timeline = useMemo(() => {
    return attempts.map((a) => ({
      date: a.submitted_at ? new Date(a.submitted_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "",
      pct: a.total ? Math.round((a.score / a.total) * 100) : 0,
    }));
  }, [attempts]);

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  if (attempts.length === 0) {
    return (
      <div className="max-w-3xl mx-auto fade-in">
        <h1 className="h1 flex items-center gap-2"><TrendingUp size={28} /> My Progress</h1>
        <p className="muted mt-1">Take a few practice tests to start seeing your mastery curve.</p>
        <div className="card mt-6 text-center py-10">
          <div className="text-4xl mb-2">📊</div>
          <div className="font-semibold mb-1">No data yet</div>
          <div className="muted text-sm mb-4">Generate and complete a test — your first results show up here.</div>
          <Link href="/student/generate" className="btn btn-primary inline-flex"><Sparkles size={16} /> New test</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <h1 className="h1 flex items-center gap-2"><TrendingUp size={28} /> My Progress</h1>
      <p className="muted mt-1">{name ? `${name.split(" ")[0]}, here` : "Here"}&apos;s how you&apos;re doing across {overall.taken} test{overall.taken === 1 ? "" : "s"}.</p>

      {/* Headline cards */}
      <div className="grid sm:grid-cols-3 gap-3 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Tests taken</div>
          <div className="text-3xl font-bold">{overall.taken}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Average score</div>
          <div className={`text-3xl font-bold ${overall.avg >= 70 ? "text-emerald-700" : overall.avg >= 50 ? "text-amber-700" : "text-red-700"}`}>
            {overall.avg}%
          </div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Topics practised</div>
          <div className="text-3xl font-bold">{familyStats.length}</div>
        </div>
      </div>

      {/* ============ FOCUS AREAS — the most clickable thing on the page ============ */}
      {(weakBlooms.length > 0 || weakTopics.length > 0) && (
        <div className="card mt-6 border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50">
          <h3 className="font-semibold flex items-center gap-2 text-amber-900"><Flame size={16} /> Focus areas</h3>
          <p className="text-xs text-amber-900/80 mt-1 mb-3">
            One click → a flashcard deck targeting exactly this weak spot.
          </p>
          <div className="flex flex-wrap gap-2">
            {weakBlooms.map((b) => (
              <Link
                key={`bloom-${b.level}`}
                href={`/student/flashcards?level=${encodeURIComponent(b.level)}`}
                className="inline-flex items-center gap-2 bg-white hover:bg-amber-100 border border-amber-300 rounded-full px-3 py-1.5 text-sm font-medium text-amber-900 transition"
              >
                <Zap size={13} /> {BLOOM_META[b.level].label} · {b.pct}%
              </Link>
            ))}
            {weakTopics.map((t) => (
              <Link
                key={`topic-${t.family}`}
                href={`/student/flashcards?topic=${encodeURIComponent(t.family)}`}
                className="inline-flex items-center gap-2 bg-white hover:bg-amber-100 border border-amber-300 rounded-full px-3 py-1.5 text-sm font-medium text-amber-900 transition"
              >
                <Target size={13} /> {t.family} · {t.avgScore}%
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ============ Bloom radar (the visual centerpiece) ============ */}
      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><TrendingUp size={20} /> Thinking-level mastery</h2>
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="card">
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <RadarChart data={radarData} outerRadius="80%">
                <PolarGrid />
                <PolarAngleAxis dataKey="level" tick={{ fontSize: 12 }} />
                <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Radar name="You" dataKey="pct" stroke="#10b981" fill="#10b981" fillOpacity={0.35} />
                <Tooltip formatter={(v: number) => `${v}%`} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs muted mt-2 text-center">
            The further the green shape reaches at a level, the stronger you are there.
            Dents = focus areas.
          </p>
        </div>

        {/* Compact level list with trends */}
        <div className="card">
          <div className="text-xs uppercase tracking-wide muted font-semibold mb-2">Per level</div>
          <div className="space-y-2.5">
            {BLOOM_LEVELS.map((lvl) => {
              const s = levelStats.find((x) => x.level === lvl);
              if (!s) return (
                <div key={lvl} className="flex items-center justify-between text-sm opacity-50">
                  <span>{BLOOM_META[lvl].label}</span>
                  <span className="text-xs">no data</span>
                </div>
              );
              return (
                <div key={lvl}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: BLOOM_META[lvl].color }} />
                      {BLOOM_META[lvl].label}
                    </span>
                    <span className="muted text-xs flex items-center gap-1.5">
                      {s.pct}%
                      {s.trend > 5 && <span className="text-emerald-700 inline-flex items-center"><TrendingUp size={11} /> {s.trend}</span>}
                      {s.trend < -5 && <span className="text-red-700 inline-flex items-center"><TrendingDown size={11} /> {s.trend}</span>}
                      {Math.abs(s.trend) <= 5 && s.total >= 4 && <Minus size={11} className="text-slate-400" />}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                    <div className="h-full rounded-full" style={{ width: `${s.pct}%`, backgroundColor: BLOOM_META[lvl].color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ============ Per-topic with sparklines ============ */}
      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><Layers size={20} /> Progress by topic</h2>
      <p className="muted text-sm mb-3">Tests on related topics are grouped so you can see whether you&apos;re actually getting better. Weakest first.</p>

      <div className="grid sm:grid-cols-2 gap-3">
        {familyStats.map((f) => (
          <div key={f.family} className="card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate">{f.family}</div>
                <div className="text-xs muted mt-0.5">
                  {f.subject ? `${f.subject} · ` : ""}{f.testCount} test{f.testCount === 1 ? "" : "s"}
                  {f.recentDate && <> · last {new Date(f.recentDate).toLocaleDateString()}</>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className={`text-2xl font-bold ${
                  f.avgScore >= 70 ? "text-emerald-700" : f.avgScore >= 50 ? "text-amber-700" : "text-red-700"
                }`}>{f.avgScore}%</div>
                {f.testCount >= 2 && (
                  f.trend > 5 ? <div className="text-[11px] text-emerald-700 inline-flex items-center gap-0.5"><TrendingUp size={11} /> +{f.trend}pp</div> :
                  f.trend < -5 ? <div className="text-[11px] text-red-700 inline-flex items-center gap-0.5"><TrendingDown size={11} /> {f.trend}pp</div> :
                  <div className="text-[11px] muted inline-flex items-center gap-0.5"><Minus size={11} /> steady</div>
                )}
              </div>
            </div>
            {/* Per-attempt mini bar chart with % on top of each bar */}
            {f.series.length >= 1 && (
              <div className="mt-3" style={{ width: "100%", height: 110 }}>
                <ResponsiveContainer>
                  <BarChart data={f.series} margin={{ top: 18, right: 6, left: 6, bottom: 4 }}>
                    <YAxis hide domain={[0, 100]} />
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#64748b" }} interval={0} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "rgba(16,185,129,0.08)" }} formatter={(v: number) => [`${v}%`, "Score"]} contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                      {f.series.map((p, i) => (
                        <Cell key={i} fill={p.pct >= 70 ? "#10b981" : p.pct >= 50 ? "#f59e0b" : "#ef4444"} />
                      ))}
                      <LabelList dataKey="pct" position="top" offset={6} style={{ fontSize: 10, fill: "#0f172a", fontWeight: 700 }} formatter={(v: number) => `${v}%`} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {f.avgScore < 70 && f.family !== UNCATEGORISED && (
              <div className="mt-3 flex items-center justify-end">
                <Link
                  href={`/student/flashcards?topic=${encodeURIComponent(f.family)}`}
                  className="btn btn-ghost text-xs text-amber-800"
                ><Layers size={12} /> Flashcards</Link>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ============ Score timeline ============ */}
      {timeline.length >= 1 && (
        <>
          <h2 className="h2 mt-8 mb-3">All scores over time</h2>
          <div className="card" style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={timeline} margin={{ top: 28, right: 12, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={{ stroke: "#cbd5e1" }} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={{ stroke: "#cbd5e1" }} tickLine={false} unit="%" />
                <Tooltip cursor={{ fill: "rgba(16,185,129,0.08)" }} formatter={(v: number) => [`${v}%`, "Score"]} />
                <Bar dataKey="pct" radius={[6, 6, 0, 0]} maxBarSize={42}>
                  {timeline.map((p, i) => (
                    <Cell key={i} fill={p.pct >= 70 ? "#059669" : p.pct >= 50 ? "#d97706" : "#dc2626"} />
                  ))}
                  <LabelList dataKey="pct" position="top" offset={8} style={{ fontSize: 11, fill: "#0f172a", fontWeight: 700 }} formatter={(v: number) => `${v}%`} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
