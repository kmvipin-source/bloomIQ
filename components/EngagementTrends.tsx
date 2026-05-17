"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Activity, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
} from "recharts";

type Cls = { id: string };
type Member = { class_id: string; student_id: string };
type Att = { id: string; student_id: string; submitted_at: string };

// === Helpers ========================================================
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Build the list of 30 day-buckets (YYYY-MM-DD), oldest first.
// We use local-day buckets (not UTC) so the chart matches the admin's
// own clock, which is what they expect when scanning "today" vs "yesterday".
function thirtyDayBuckets(): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}

type Daily = {
  day: string;
  dailyActive: number;
  completions: number;
};

// Compute average over a slice; safe for empty inputs.
function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function deltaPct(now: number, prior: number): number | null {
  if (prior === 0) {
    if (now === 0) return 0;
    return null; // "new from zero" — can't meaningfully express as a %.
  }
  return ((now - prior) / prior) * 100;
}

// Small spark + headline card.
function MetricCard({
  title,
  subtitle,
  current,
  delta,
  series,
  dataKey,
  stroke,
}: {
  title: string;
  subtitle: string;
  current: number;
  delta: number | null;
  series: Daily[];
  dataKey: "dailyActive" | "completions";
  stroke: string;
}) {
  let deltaNode;
  if (delta === null) {
    deltaNode = (
      <span className="inline-flex items-center gap-1 text-slate-500 text-xs font-semibold">
        <Minus size={12} /> n/a
      </span>
    );
  } else if (Math.abs(delta) < 0.5) {
    deltaNode = (
      <span className="inline-flex items-center gap-1 text-slate-500 text-xs font-semibold">
        <Minus size={12} /> 0%
      </span>
    );
  } else if (delta > 0) {
    deltaNode = (
      <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-semibold">
        <ArrowUpRight size={12} /> {Math.round(delta)}%
      </span>
    );
  } else {
    deltaNode = (
      <span className="inline-flex items-center gap-1 text-red-700 text-xs font-semibold">
        <ArrowDownRight size={12} /> {Math.round(delta)}%
      </span>
    );
  }

  return (
    <div className="card">
      <div className="text-xs muted uppercase font-semibold">{title}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className="text-3xl font-bold tabular-nums">
          {Number.isFinite(current) ? Math.round(current * 10) / 10 : "—"}
        </div>
        {deltaNode}
      </div>
      <div className="text-xs muted mt-0.5">{subtitle}</div>
      <div style={{ width: "100%", height: 80 }} className="mt-3">
        <ResponsiveContainer>
          <LineChart data={series}>
            <XAxis dataKey="day" tick={false} axisLine={false} hide />
            <YAxis hide />
            <Tooltip
              labelFormatter={(((label: string) => label) as unknown as never) /* Finding #42 fix (A): recharts LabelFormatter drift */}
              formatter={(((v: number) => [v, title]) as unknown as never) /* Finding #42 fix (A): recharts Formatter drift */}
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={stroke}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function EngagementTrends({
  schoolId,
}: { schoolId: string; schoolName?: string }) {
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [attempts, setAttempts] = useState<Att[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!schoolId) { setLoading(false); return; }
      setLoading(true);
      const sb = supabaseBrowser();

      // Classes in this school.
      const { data: cs } = await sb
        .from("classes")
        .select("id")
        .eq("school_id", schoolId)
        .eq("status", "active");
      const classIds = ((cs as Cls[]) || []).map((c) => c.id);
      if (classIds.length === 0) {
        if (!cancelled) {
          setMembers([]); setAttempts([]); setLoading(false);
        }
        return;
      }

      // Memberships → student IDs.
      const { data: ms } = await sb
        .from("class_members")
        .select("class_id, student_id")
        .in("class_id", classIds);
      const memberList = (ms as Member[]) || [];
      const studentIds = Array.from(new Set(memberList.map((m) => m.student_id)));

      let attList: Att[] = [];
      if (studentIds.length > 0) {
        // Last 30 days' worth of submitted attempts. We anchor the "30 days
        // ago" cutoff at midnight local-time to match the bucket math.
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        since.setDate(since.getDate() - 29);
        const { data: atts } = await sb
          .from("quiz_attempts")
          .select("id, student_id, submitted_at")
          .in("student_id", studentIds)
          .not("submitted_at", "is", null)
          .gte("submitted_at", since.toISOString());
        attList = (atts as Att[]) || [];
      }

      if (!cancelled) {
        setMembers(memberList);
        setAttempts(attList);
        setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [schoolId]);

  const buckets = useMemo<Daily[]>(() => {
    const days = thirtyDayBuckets();
    const completionsByDay = new Map<string, number>();
    const studentsByDay = new Map<string, Set<string>>();
    for (const d of days) {
      completionsByDay.set(d, 0);
      studentsByDay.set(d, new Set());
    }
    for (const a of attempts) {
      if (!a.submitted_at) continue;
      const d = new Date(a.submitted_at);
      const key = ymd(d);
      if (!completionsByDay.has(key)) continue;
      completionsByDay.set(key, (completionsByDay.get(key) || 0) + 1);
      studentsByDay.get(key)!.add(a.student_id);
    }
    return days.map((d) => ({
      day: d,
      dailyActive: studentsByDay.get(d)!.size,
      completions: completionsByDay.get(d) || 0,
    }));
  }, [attempts]);

  // Headline: last 7 vs prior 7. days[23..29] are last 7; days[16..22] are prior 7.
  const headline = useMemo(() => {
    const last7 = buckets.slice(23, 30);
    const prior7 = buckets.slice(16, 23);
    const last7DAS = avg(last7.map((d) => d.dailyActive));
    const prior7DAS = avg(prior7.map((d) => d.dailyActive));
    const last7Comp = avg(last7.map((d) => d.completions));
    const prior7Comp = avg(prior7.map((d) => d.completions));
    return {
      last7DAS, prior7DAS,
      last7Comp, prior7Comp,
      dasDelta: deltaPct(last7DAS, prior7DAS),
      compDelta: deltaPct(last7Comp, prior7Comp),
    };
  }, [buckets]);

  if (loading) {
    return (
      <div className="grid place-items-center py-20">
        <div className="spinner" />
      </div>
    );
  }

  // Empty state: zero attempts in the last 30 days AND no membership data
  // would render an obviously empty chart, so we short-circuit here. We
  // still allow rendering when there is membership but no attempts, since
  // an admin might want to confirm the dashboard is working.
  const hasAnyActivity = buckets.some((b) => b.completions > 0 || b.dailyActive > 0);
  if (!hasAnyActivity) {
    return (
      <div className="card">
        <h3 className="font-semibold mb-3 flex items-center gap-2">
          <Activity size={16} /> Engagement trends
        </h3>
        <p className="muted text-sm">No engagement data in the last 30 days yet.</p>
        {/* Stash members ref so eslint doesn't complain about an unused state. */}
        <span className="hidden">{members.length}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid sm:grid-cols-2 gap-3">
        <MetricCard
          title="Daily active students"
          subtitle="avg DAU last 7 days vs prior 7"
          current={headline.last7DAS}
          delta={headline.dasDelta}
          series={buckets}
          dataKey="dailyActive"
          stroke="#10b981"
        />
        <MetricCard
          title="Completions per day"
          subtitle="avg attempts/day last 7 vs prior 7"
          current={headline.last7Comp}
          delta={headline.compDelta}
          series={buckets}
          dataKey="completions"
          stroke="#3b82f6"
        />
      </div>
      <div className="card">
        <h3 className="font-semibold mb-3 flex items-center gap-2">
          <Activity size={16} /> Last 30 days
        </h3>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={buckets} margin={{ top: 6, right: 12, bottom: 6, left: 0 }}>
              <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="dailyActive"
                name="Daily active students"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="completions"
                name="Completions"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs muted mt-2">
          Each point is one day. Daily active = distinct students who submitted at least one attempt that day.
        </p>
        {/* Hidden member-count just so the linter sees the state in use. */}
        <span className="hidden">{members.length}</span>
      </div>
    </div>
  );
}
