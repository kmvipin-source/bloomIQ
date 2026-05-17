import { NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import type { BloomLevel } from "@/lib/bloom";

export const runtime = "nodejs";

/**
 * POST /api/teacher/quiz-suggest  —  Finding #71 (Round 14)
 *
 * Body: {
 *   class_id?: string | null,
 *   depth?: "broad" | "mid" | "deep",
 *   count?: number,
 *   topic?: string | null,
 * }
 *
 * Picks `count` questions from the caller's APPROVED question bank with
 * diversity heuristics:
 *
 *   1. Filter the bank by:
 *        - owner_id = caller (RLS would also enforce this; double-belt
 *          since we go through service role for the read).
 *        - status = "approved"
 *        - class_id = body.class_id (when provided)
 *        - topic ILIKE %body.topic% (when provided; fuzzy)
 *
 *   2. From the filtered set, pick a balanced Bloom mix sized to the
 *      requested depth:
 *        - broad: Remember / Understand / Apply heavy
 *        - mid:   Apply / Analyze / Evaluate
 *        - deep:  Analyze / Evaluate / Create
 *
 *   3. Within each Bloom slot, prefer questions whose topic hasn't been
 *      picked yet (topic spread), then fall back to anything available.
 *
 * Returns:
 *   {
 *     ok: true,
 *     question_ids: string[],
 *     bloom_breakdown: Record<BloomLevel, number>,
 *     topics: string[],
 *     bank_size: number,    // total bank rows matching the filter
 *     matched: number,      // how many were ACTUALLY picked
 *   }
 *
 * No LLM call. The "AI" framing is product-facing; this is a pure
 * server-side diversity-aware sampler over the teacher's existing bank.
 * Keeps the feature free + fast + cost-zero — important since this is
 * one of the most-pressed buttons on the composer.
 */

type Depth = "broad" | "mid" | "deep";

const BLOOM_MIX: Record<Depth, BloomLevel[]> = {
  // Each array is the proportional template: cycling through these in
  // order until we've picked `count`. Earlier entries get more slots
  // because we cycle from the start.
  broad: ["remember", "understand", "apply", "remember", "understand", "apply", "analyze"],
  mid:   ["apply", "analyze", "evaluate", "apply", "analyze", "understand", "apply"],
  deep:  ["analyze", "evaluate", "create", "analyze", "evaluate", "apply", "analyze"],
};

type BankRow = {
  id: string;
  topic: string | null;
  bloom_level: BloomLevel;
};

export async function POST(req: Request) {
  try {
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, admin } = auth;

    const body = await req.json().catch(() => ({}));
    const classId = body.class_id ? String(body.class_id) : null;
    const depth = (["broad", "mid", "deep"].includes(body.depth) ? body.depth : "mid") as Depth;
    const count = Math.max(3, Math.min(40, Number(body.count) || 10));
    const topic = body.topic ? String(body.topic).trim() : null;

    // 1) Filter bank by owner + status + optional class + optional topic.
    let q = admin
      .from("question_bank")
      .select("id, topic, bloom_level")
      .eq("owner_id", user.id)
      .eq("status", "approved")
      .limit(500);
    if (classId) q = q.eq("class_id", classId);
    if (topic) q = q.ilike("topic", `%${topic}%`);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const bank = (data || []) as BankRow[];
    if (bank.length === 0) {
      return NextResponse.json({
        ok: true,
        question_ids: [],
        bloom_breakdown: {},
        topics: [],
        bank_size: 0,
        matched: 0,
      });
    }

    // 2) Index by Bloom level for fast pop.
    const byBloom: Record<BloomLevel, BankRow[]> = {
      remember: [], understand: [], apply: [], analyze: [], evaluate: [], create: [],
    };
    for (const row of bank) {
      if (row.bloom_level in byBloom) byBloom[row.bloom_level].push(row);
    }

    // Shuffle each bucket so picks are non-deterministic across calls
    // (otherwise the same 10 questions surface every time and teachers
    // get tired of the suggester quickly).
    for (const lv of Object.keys(byBloom) as BloomLevel[]) {
      byBloom[lv].sort(() => Math.random() - 0.5);
    }

    // 3) Walk the depth template, prefer topic-spread within each pick.
    const template = BLOOM_MIX[depth];
    const picked: BankRow[] = [];
    const pickedIds = new Set<string>();
    const pickedTopics = new Set<string>();
    let templateIdx = 0;
    let exhaustedRounds = 0;

    while (picked.length < count && exhaustedRounds < 3) {
      const want = template[templateIdx % template.length];
      const bucket = byBloom[want];
      // Prefer a question whose topic isn't already in pickedTopics.
      let chosenIdx = -1;
      for (let i = 0; i < bucket.length; i++) {
        const cand = bucket[i];
        if (pickedIds.has(cand.id)) continue;
        const t = (cand.topic || "").trim().toLowerCase();
        if (t && !pickedTopics.has(t)) { chosenIdx = i; break; }
      }
      // Fallback: any question from this bucket we haven't picked yet.
      if (chosenIdx < 0) {
        for (let i = 0; i < bucket.length; i++) {
          if (!pickedIds.has(bucket[i].id)) { chosenIdx = i; break; }
        }
      }
      if (chosenIdx >= 0) {
        const cand = bucket[chosenIdx];
        picked.push(cand);
        pickedIds.add(cand.id);
        if (cand.topic) pickedTopics.add(cand.topic.trim().toLowerCase());
      } else {
        // No more questions at this level; bump template ptr and count
        // exhaustion. If we cycle through the whole template thrice
        // without finding anything, give up — bank is fully drained.
        exhaustedRounds += templateIdx % template.length === template.length - 1 ? 1 : 0;
      }
      templateIdx += 1;
    }

    // 4) Build response telemetry.
    const bloom_breakdown: Record<string, number> = {};
    for (const p of picked) {
      bloom_breakdown[p.bloom_level] = (bloom_breakdown[p.bloom_level] || 0) + 1;
    }
    const topics = Array.from(new Set(picked.map((p) => (p.topic || "").trim()).filter(Boolean)));

    return NextResponse.json({
      ok: true,
      question_ids: picked.map((p) => p.id),
      bloom_breakdown,
      topics,
      bank_size: bank.length,
      matched: picked.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Suggest failed" },
      { status: 500 },
    );
  }
}
