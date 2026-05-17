import { NextResponse } from "next/server";
import { aiJSON } from "@/lib/aiClient";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { consumeLifetimeUse } from "@/lib/freeQuota";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/graph/build
// -----------------------------------------------------------------------------
// Builds (or rebuilds, if `force: true`) the student's concept knowledge graph.
//
// Steps:
//   1. Pull the student's distinct topics from question_bank + their per-topic
//      mastery from attempt_answers.
//   2. Ask Groq to infer prerequisite relationships between those topics
//      (one call, JSON in/out).
//   3. Persist nodes + edges as jsonb in knowledge_graphs.
//   4. Return the graph for the page to render.
//
// Caching: if there's already a graph computed within the last 24h, return
// it directly unless `force: true` is set. Saves Groq tokens.
// =============================================================================

const SYSTEM = `You are a curriculum designer mapping prerequisite relationships between topics a student has studied.

You will be given a list of topics. For each pair where one topic is a prerequisite for another (you'd need to learn topic A before topic B makes sense), output an edge.

Rules:
- Only output edges where the prerequisite relationship is widely accepted (not obscure).
- Each edge is { from: <prereq topic>, to: <dependent topic>, kind: "prereq" }.
- For topics that are loosely related but not strictly prerequisite, use kind: "related".
- Output AT MOST 30 edges. Prefer prereq over related when both apply.
- Skip topics that don't fit anywhere.

Respond with VALID JSON only:
{
  "edges": [
    { "from": "Algebra", "to": "Calculus", "kind": "prereq" },
    { "from": "Cell Division", "to": "Genetics", "kind": "prereq" }
  ]
}`;

type Edge = { from: string; to: string; kind: "prereq" | "related" };

type NodeOut = {
  id: string;          // sanitized topic name (used as id)
  topic: string;       // original topic
  mastery: number;     // 0..100
  n_questions: number;
  bloom_levels: BloomLevel[];
};

function topicId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;
    const rate = checkRateLimit(user.id, "graph.build", { capacity: 5, refillPerHour: 10 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const ltGate = await consumeLifetimeUse(user.id, "knowledge_graph");
    if (!ltGate.allowed) return NextResponse.json({ error: ltGate.reason, code: "free_lifetime_used" }, { status: 402 });

    const body = await req.json().catch(() => ({}));
    const force = body.force === true;

    // ----- Cache check -----
    if (!force) {
      const { data: cached } = await sb
        .from("knowledge_graphs")
        .select("graph, computed_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cached) {
        const age = Date.now() - new Date(cached.computed_at as string).getTime();
        if (age < 24 * 60 * 60 * 1000) {
          return NextResponse.json({ ok: true, cached: true, computed_at: cached.computed_at, graph: cached.graph });
        }
      }
    }

    // ----- Pull distinct topics + Bloom levels for the user's questions -----
    const { data: qs } = await sb
      .from("question_bank")
      .select("id, topic, bloom_level")
      .eq("owner_id", user.id)
      .not("topic", "is", null);
    const qsArr = ((qs || []) as Array<{ id: string; topic: string | null; bloom_level: string }>);

    if (qsArr.length === 0) {
      // No data yet — return empty graph and persist a fresh empty cache.
      const empty = { nodes: [], edges: [] };
      await sb.from("knowledge_graphs").upsert({ user_id: user.id, graph: empty, computed_at: new Date().toISOString() });
      return NextResponse.json({ ok: true, cached: false, graph: empty });
    }

    // ----- Per-topic stats: question count + Bloom levels touched -----
    const byTopic = new Map<string, { topic: string; q_ids: string[]; bloom: Set<BloomLevel> }>();
    for (const q of qsArr) {
      if (!q.topic) continue;
      const key = q.topic.trim();
      const entry = byTopic.get(key) || { topic: key, q_ids: [], bloom: new Set<BloomLevel>() };
      entry.q_ids.push(q.id);
      if ((BLOOM_LEVELS as readonly string[]).includes(q.bloom_level)) {
        entry.bloom.add(q.bloom_level as BloomLevel);
      }
      byTopic.set(key, entry);
    }

    // ----- Mastery per topic from attempt_answers (last 60 days) -----
    const allQIds = qsArr.map((q) => q.id);
    const sixtyDaysAgo = new Date(); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const { data: ans } = await sb
      .from("attempt_answers")
      .select("question_id, is_correct")
      .in("question_id", allQIds.slice(0, 500)); // safety cap on .in()
    const tally = new Map<string, { correct: number; total: number }>();
    ((ans || []) as Array<{ question_id: string; is_correct: boolean | null }>).forEach((a) => {
      const t = tally.get(a.question_id) || { correct: 0, total: 0 };
      t.total += 1;
      if (a.is_correct) t.correct += 1;
      tally.set(a.question_id, t);
    });

    void sixtyDaysAgo; // (kept for future windowing; presently we use all-time mastery)

    const nodes: NodeOut[] = [];
    for (const [, entry] of byTopic) {
      let correct = 0, total = 0;
      for (const qid of entry.q_ids) {
        const t = tally.get(qid);
        if (t) { correct += t.correct; total += t.total; }
      }
      const mastery = total > 0 ? Math.round((correct / total) * 100) : 0;
      nodes.push({
        id: topicId(entry.topic),
        topic: entry.topic,
        mastery,
        n_questions: entry.q_ids.length,
        bloom_levels: Array.from(entry.bloom),
      });
    }

    // Sort nodes by topic name for stable layout.
    nodes.sort((a, b) => a.topic.localeCompare(b.topic));

    // ----- Ask Groq for prerequisite edges -----
    let edges: Edge[] = [];
    if (nodes.length >= 2) {
      try {
        const userPrompt = `Topics studied:\n${nodes.map((n) => `- ${n.topic}`).join("\n")}\n\nReturn the edges JSON.`;
        const raw = await aiJSON(SYSTEM, userPrompt);
        const arr = (raw as { edges?: unknown }).edges;
        if (Array.isArray(arr)) {
          const idMap = new Map(nodes.map((n) => [n.topic.toLowerCase(), n.id]));
          edges = (arr as unknown[])
            .map((e) => {
              const o = (e || {}) as Record<string, unknown>;
              const fromT = String(o.from || "").trim().toLowerCase();
              const toT = String(o.to || "").trim().toLowerCase();
              const kindRaw = String(o.kind || "prereq");
              const kind: "prereq" | "related" = kindRaw === "related" ? "related" : "prereq";
              const fromId = idMap.get(fromT);
              const toId = idMap.get(toT);
              if (!fromId || !toId || fromId === toId) return null;
              return { from: fromId, to: toId, kind };
            })
            .filter((e): e is Edge => e !== null)
            .slice(0, 50);
          // Dedup by (from,to,kind)
          const seen = new Set<string>();
          edges = edges.filter((e) => {
            const k = `${e.from}|${e.to}|${e.kind}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
      } catch { /* leave edges empty if AI fails — graph still renders */ }
    }

    const graph = { nodes, edges };
    await sb.from("knowledge_graphs").upsert({
      user_id: user.id,
      graph,
      computed_at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, cached: false, graph });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Graph build failed" },
      { status: 500 }
    );
  }
}
