"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, Network, Sparkles, Loader2, RefreshCw } from "lucide-react";

// =============================================================================
// CONCEPT KNOWLEDGE GRAPH — visual mastery map. Hand-rolled SVG layout (no
// graph library deps): nodes are arranged in concentric mastery rings (lowest
// in the center, highest on the outer ring). Edges drawn between nodes show
// AI-inferred prerequisite or related relationships.
//
// Layout philosophy:
//   - The center of the canvas = "you don't know it yet"
//   - The outer ring = "you've mastered this"
//   - So the graph naturally tells the student "look at the inside; that's
//     where to focus."
// =============================================================================

type Node = {
  id: string;
  topic: string;
  mastery: number;      // 0..100
  n_questions: number;
  bloom_levels: string[];
};
type Edge = { from: string; to: string; kind: "prereq" | "related" };
type Graph = { nodes: Node[]; edges: Edge[] };

type Resp = { graph: Graph; cached: boolean; computed_at?: string };

const W = 720;        // SVG canvas width
const H = 560;        // SVG canvas height
const CX = W / 2;
const CY = H / 2;

// Place nodes on concentric rings — radius shrinks as mastery rises (so weak
// topics sit on the outside where they catch the eye, mastered topics shrink
// toward center as "done"). Sorted around the ring by topic name for stability.
function layoutNodes(nodes: Node[]): Map<string, { x: number; y: number; r: number }> {
  const out = new Map<string, { x: number; y: number; r: number }>();
  if (nodes.length === 0) return out;

  // Sort: most-uncertain first (mastery near 50%) get prime radial position;
  // then weakest, then strongest. This puts the "interesting" nodes prominent.
  const ordered = [...nodes].sort((a, b) => {
    const aGap = Math.abs(50 - a.mastery);
    const bGap = Math.abs(50 - b.mastery);
    if (aGap !== bGap) return aGap - bGap;
    return a.topic.localeCompare(b.topic);
  });

  const N = ordered.length;
  // Ring radii — three rings + center.
  const ringMax = Math.min(W, H) / 2 - 50;
  const ring = (i: number) => {
    if (N <= 4) return ringMax * 0.6;
    if (N <= 10) return ringMax * (i < 4 ? 0.45 : 0.85);
    return ringMax * (i < Math.ceil(N / 3) ? 0.35 : i < Math.ceil((N * 2) / 3) ? 0.65 : 0.9);
  };

  // Spread evenly around circle.
  ordered.forEach((n, i) => {
    const angle = (i / N) * 2 * Math.PI - Math.PI / 2;
    const r = ring(i);
    const nodeRadius = 26 + Math.min(20, Math.sqrt(n.n_questions) * 4);
    out.set(n.id, {
      x: CX + r * Math.cos(angle),
      y: CY + r * Math.sin(angle),
      r: nodeRadius,
    });
  });
  return out;
}

function masteryColor(m: number): string {
  // 0 → red, 50 → amber, 100 → emerald.
  if (m >= 80) return "#10b981";
  if (m >= 60) return "#34d399";
  if (m >= 40) return "#f59e0b";
  if (m >= 20) return "#f97316";
  return "#ef4444";
}

export default function GraphPage() {
  const [resp, setResp] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => { void load(false); }, []);

  async function load(force: boolean) {
    setErr(null);
    if (!force) setLoading(true);
    else setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/graph/build", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ force }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Graph build failed");
      setResp(j as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Graph build failed");
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }

  const positions = useMemo(() => layoutNodes(resp?.graph.nodes || []), [resp]);
  const hoveredNode = resp?.graph.nodes.find((n) => n.id === hover) || null;

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-blue-100 text-blue-700 p-3 shrink-0">
          <Network size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Knowledge Graph</h1>
          <p className="muted mt-1">
            Every topic you&apos;ve practiced, color-coded by mastery, with AI-inferred prerequisite arrows. See
            why a tricky topic is tricky — usually the foundation node is shaky.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-20"><div className="spinner" /></div>
      ) : err ? (
        <div className="card mt-6 text-sm text-red-700 bg-red-50 border border-red-200">{err}</div>
      ) : !resp || resp.graph.nodes.length === 0 ? (
        <div className="card mt-6 text-center py-10">
          <Sparkles size={20} className="mx-auto text-blue-500 mb-2" />
          <h2 className="font-semibold">No topics yet</h2>
          <p className="text-sm muted mt-1 max-w-md mx-auto">
            Take a few practice tests on different topics, then come back. The graph builds itself from your
            practice history.
          </p>
          <Link href="/student/generate" className="btn btn-primary mt-4">Generate a test →</Link>
        </div>
      ) : (
        <>
          {/* Stats + refresh */}
          <div className="card mt-6 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4 flex-wrap text-sm">
              <span><strong>{resp.graph.nodes.length}</strong> topics</span>
              <span className="muted">·</span>
              <span><strong>{resp.graph.edges.length}</strong> prerequisite links</span>
              {resp.computed_at && (
                <>
                  <span className="muted">·</span>
                  <span className="muted text-xs">computed {new Date(resp.computed_at).toLocaleString()}</span>
                </>
              )}
            </div>
            <button className="btn btn-secondary" onClick={() => load(true)} disabled={busy}>
              {busy ? <><Loader2 className="animate-spin" size={14} /> Rebuilding…</> : <><RefreshCw size={14} /> Rebuild graph</>}
            </button>
          </div>

          {/* Legend */}
          <div className="card mt-3 flex items-center gap-3 flex-wrap text-xs">
            <span className="muted uppercase font-semibold tracking-wide">Mastery</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: "#ef4444" }} /> 0–20</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: "#f97316" }} /> 20–40</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: "#f59e0b" }} /> 40–60</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: "#34d399" }} /> 60–80</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: "#10b981" }} /> 80–100</span>
            <span className="muted ml-auto">Solid arrow = prerequisite · dashed = related</span>
          </div>

          {/* SVG canvas */}
          <div className="card mt-3 p-2 overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: 460 }}>
              {/* Edges first (under nodes) */}
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                </marker>
              </defs>
              {(resp.graph.edges).map((e, i) => {
                const a = positions.get(e.from);
                const b = positions.get(e.to);
                if (!a || !b) return null;
                // Trim line ends so it stops at the node circle.
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist === 0) return null;
                const ux = dx / dist;
                const uy = dy / dist;
                const x1 = a.x + ux * a.r;
                const y1 = a.y + uy * a.r;
                const x2 = b.x - ux * (b.r + 8);
                const y2 = b.y - uy * (b.r + 8);
                return (
                  <line
                    key={i}
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    strokeDasharray={e.kind === "related" ? "4 4" : undefined}
                    markerEnd="url(#arrow)"
                  />
                );
              })}

              {/* Nodes */}
              {(resp.graph.nodes).map((n) => {
                const p = positions.get(n.id);
                if (!p) return null;
                const isHover = hover === n.id;
                return (
                  <g
                    key={n.id}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={p.r}
                      fill={masteryColor(n.mastery)}
                      fillOpacity={isHover ? 1 : 0.85}
                      stroke={isHover ? "#0f172a" : "#fff"}
                      strokeWidth={isHover ? 2 : 1.5}
                    />
                    <text
                      x={p.x}
                      y={p.y - 2}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight="600"
                      fill="#fff"
                      style={{ pointerEvents: "none" }}
                    >
                      {n.topic.length > 14 ? n.topic.slice(0, 12) + "…" : n.topic}
                    </text>
                    <text
                      x={p.x}
                      y={p.y + 12}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#fff"
                      fillOpacity="0.85"
                      style={{ pointerEvents: "none" }}
                    >
                      {n.mastery}%
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Hovered-node detail panel */}
          {hoveredNode && (
            <div className="card mt-3 bg-slate-50 border-slate-200">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="font-semibold text-base">{hoveredNode.topic}</div>
                  <div className="text-xs muted mt-0.5">
                    Mastery <strong>{hoveredNode.mastery}%</strong> · {hoveredNode.n_questions} question{hoveredNode.n_questions === 1 ? "" : "s"} practised
                    {hoveredNode.bloom_levels.length > 0 && (
                      <> · Bloom levels: {hoveredNode.bloom_levels.join(", ")}</>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link href={`/student/visualizer`} className="btn btn-secondary text-xs">Animate this</Link>
                  <Link href={`/student/generate`} className="btn btn-primary text-xs">Practice more</Link>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
