"use client";
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";

type LevelStat = { level: BloomLevel; correct: number; total: number };

export function BloomRadar({ data }: { data: LevelStat[] }) {
  const chartData = BLOOM_LEVELS.map((lvl) => {
    const s = data.find((d) => d.level === lvl);
    const pct = s && s.total ? Math.round((s.correct / s.total) * 100) : 0;
    return { level: BLOOM_META[lvl].label, score: pct };
  });
  return (
    <div className="w-full h-72">
      <ResponsiveContainer>
        <RadarChart data={chartData} outerRadius="75%">
          <PolarGrid />
          <PolarAngleAxis dataKey="level" tick={{ fontSize: 12, fill: "#475569" }} />
          <PolarRadiusAxis domain={[0, 100]} angle={30} tick={{ fontSize: 10 }} />
          <Radar name="Score %" dataKey="score" stroke="#059669" fill="#10b981" fillOpacity={0.45} />
          <Tooltip formatter={((v: number) => `${v}%`) as unknown as never /* Finding #41 fix (A): recharts Formatter signature drift; runtime unchanged */} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BloomBars({ data }: { data: LevelStat[] }) {
  const chartData = BLOOM_LEVELS.map((lvl) => {
    const s = data.find((d) => d.level === lvl);
    const pct = s && s.total ? Math.round((s.correct / s.total) * 100) : 0;
    return { level: BLOOM_META[lvl].label, score: pct, color: BLOOM_META[lvl].color };
  });
  return (
    <div className="w-full h-64">
      <ResponsiveContainer>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="level" tick={{ fontSize: 12, fill: "#475569" }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: "#475569" }} />
          <Tooltip formatter={((v: number) => `${v}%`) as unknown as never /* Finding #41 fix (A): recharts Formatter signature drift; runtime unchanged */} />
          <Bar dataKey="score" radius={[6, 6, 0, 0]}>
            {chartData.map((c, i) => <Cell key={i} fill={c.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
