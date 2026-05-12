/**
 * lib/recentStemsExclusion.ts
 *
 * Cross-test question-repetition prevention. The pre-2026-05-12 pipeline
 * generated each batch in isolation — same student asking for the same
 * topic on consecutive days would see overlapping (often identical)
 * questions because the AI is stateless and converges to canonical
 * questions for narrow topics. Vipin flagged this as a hook-killer
 * ("test is the most important aspect to hook students").
 *
 * Three reinforcing layers:
 *   1. Pull the last N stems the student has actually answered for this
 *      topic + bloom_level + recency window, and inject them into the AI
 *      prompt as an explicit exclusion list. LLMs honour "don't repeat
 *      these" much more reliably than generic "be diverse" instructions.
 *   2. Extract the top frequency meaningful words from those stems and
 *      surface them as "concepts already covered: X, Y, Z. Generate on
 *      OTHER angles." This nudges the AI off the well-trodden corner of
 *      the topic and into a different sub-aspect.
 *   3. Post-generation: callers run Jaccard against the same recent
 *      stems and drop any new question that's ≥ 0.7 similar (handled in
 *      lib/qgen.ts → filterQuestionBatch, not here).
 *
 * Tables hit:
 *   attempt_answers (question_id, bloom_level, attempt_id, time)
 *   ⨝ question_bank (id, stem, topic, owner_id)
 *
 * Auth posture:
 *   Pass a SERVICE-ROLE (supabaseAdmin) client. The user-token client
 *   races RLS on the edge for cross-table joins and we'd miss stems
 *   silently — which is the worst failure mode here (means repetition
 *   not blocked, with no warning).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BloomLevel } from "@/lib/bloom";

// ─── Tunables ────────────────────────────────────────────────────────────

/** How many days back to look. 30 days = "I might still remember this
 *  question if I see it again." Beyond that, repetition is acceptable. */
const RECENT_WINDOW_DAYS = 30;

/** Cap on how many stems we pass to the AI. Past ~25 the prompt blows
 *  past the model's effective attention; 20 is a sweet spot. */
const DEFAULT_LIMIT = 20;

/** Cap on how many "concepts already covered" tokens we surface in
 *  Layer 3. Too many = the AI gets confused about what to avoid. */
const TOP_CONCEPTS_TO_SURFACE = 6;

/** Tokens shorter than this are dropped from the concept-frequency
 *  scan (the/and/of/with — would dominate any frequency count). */
const MIN_CONCEPT_TOKEN_LENGTH = 5;

// ─── English stop-words ─────────────────────────────────────────────────
// Common words that appear in question stems but don't carry topic
// signal. Kept lowercase, deliberately conservative — we'd rather let
// a marginally-useful token through than strip a domain term.
const STOPWORDS = new Set([
  "about", "above", "across", "after", "against", "again", "along", "amongst",
  "before", "behind", "below", "between", "beyond", "during", "either",
  "every", "following", "ignore", "important", "imply", "include", "includes",
  "including", "involves", "involve", "knowledge", "matter", "means", "meaning",
  "neither", "never", "often", "other", "others", "particular", "really",
  "represent", "results", "select", "several", "shall", "should", "since",
  "specifically", "statement", "statements", "suppose", "their", "there",
  "these", "thing", "things", "those", "through", "until", "unless", "using",
  "value", "values", "while", "whilst", "which", "would", "without", "within",
  "answer", "answers", "choose", "consider", "correct", "describe", "example",
  "examples", "explain", "follow", "follows", "given", "below", "above", "best",
  "compute", "describe", "different", "evaluate", "explain", "find", "given",
  "identify", "label", "label", "mention", "outline", "perform", "predict",
  "question", "questions", "quote", "right", "state", "summary", "support",
  "though", "weight", "wrong", "yields",
]);

// ─── Types ───────────────────────────────────────────────────────────────

export type ExclusionPayload = {
  /** Verbatim stems the student has already seen, newest first. */
  stems: string[];
  /** Top topic-concept tokens extracted from those stems, sorted by
   *  frequency desc. Used in Layer 3 to nudge the AI off the same
   *  sub-aspect of the topic. */
  conceptsAlreadyCovered: string[];
  /** Pre-formatted prompt block ready to append to the SYSTEM or USER
   *  prompt. Empty string when there are no stems to exclude (so the
   *  AI behaves exactly as before for a fresh user). */
  promptBlock: string;
};

// ─── Read path ───────────────────────────────────────────────────────────

/**
 * Fetch up to `limit` stems the student has already answered across ALL
 * question-generation surfaces, filtered to this topic + bloom_level (if
 * specified) within the last 30 days.
 *
 * Vipin caught a critical gap on 2026-05-13: Speed Trainer (and Daily
 * Drill) store their questions in JSONB blobs on session/attempt rows,
 * NOT in the canonical attempt_answers / question_bank tables. The old
 * implementation only queried the canonical path, returning 0 stems for
 * Speed Trainer history — which is exactly why 2/5 questions repeated
 * across consecutive Speed Trainer runs on "CICS mainframe".
 *
 * This pass merges THREE data sources, newest-first:
 *   1. quiz_attempts → attempt_answers → question_bank
 *      (quick-test, adaptive practice, teacher quizzes, assigned quizzes)
 *   2. speed_sessions.questions JSONB
 *      (Speed-Accuracy Trainer)
 *   3. daily_drill_attempts.items JSONB
 *      (Daily Drill)
 *
 * Tolerates RLS / network blips per-source by catching errors at each
 * step — partial data is better than no exclusion at all.
 */
async function fetchRecentSeenStems(
  sb: SupabaseClient,
  userId: string,
  topic: string,
  bloomLevel: BloomLevel | null,
  limit: number,
): Promise<string[]> {
  const sinceIso = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const topicLower = (topic || "").toLowerCase().trim();

  // Each source contributes (stem, createdAt) tuples. We merge, dedupe,
  // sort newest-first, then slice to `limit`.
  type StemEntry = { stem: string; createdAt: number };
  const collected: StemEntry[] = [];

  // ─── Source 1: attempt_answers (canonical persisted-quiz path) ─────
  try {
    const { data: ans } = await sb
      .from("attempt_answers")
      .select("question_id, bloom_level, attempt_id, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200);
    type AnsRow = { question_id: string; bloom_level: BloomLevel; attempt_id: string; created_at: string };
    const ansTyped = (ans as AnsRow[] | null) || [];
    const inBloom = bloomLevel
      ? ansTyped.filter((a) => a.bloom_level === bloomLevel)
      : ansTyped;
    if (inBloom.length > 0) {
      const attemptIds = Array.from(new Set(inBloom.map((a) => a.attempt_id)));
      const { data: atts } = await sb
        .from("quiz_attempts")
        .select("id, student_id")
        .in("id", attemptIds);
      type AttRow = { id: string; student_id: string };
      const mine = new Set(
        ((atts as AttRow[] | null) || [])
          .filter((a) => a.student_id === userId)
          .map((a) => a.id)
      );
      const mineOnly = inBloom.filter((a) => mine.has(a.attempt_id));
      if (mineOnly.length > 0) {
        const qIds = Array.from(new Set(mineOnly.map((a) => a.question_id)));
        const { data: qb } = await sb
          .from("question_bank")
          .select("id, stem, topic")
          .in("id", qIds);
        type QbRow = { id: string; stem: string; topic: string | null };
        const byId = new Map<string, QbRow>();
        ((qb as QbRow[] | null) || []).forEach((r) => byId.set(r.id, r));
        for (const a of mineOnly) {
          const q = byId.get(a.question_id);
          if (!q?.stem) continue;
          if (topicLower) {
            const qt = (q.topic || "").toLowerCase();
            const matches =
              (qt && (qt.includes(topicLower) || topicLower.includes(qt))) ||
              (!qt && q.stem.toLowerCase().includes(topicLower));
            if (!matches) continue;
          }
          collected.push({ stem: q.stem.trim(), createdAt: new Date(a.created_at).getTime() });
        }
      }
    }
  } catch { /* fall through to other sources */ }

  // ─── Source 2: speed_sessions.questions (Speed-Accuracy Trainer) ───
  try {
    const { data: sessions } = await sb
      .from("speed_sessions")
      .select("topic, questions, created_at")
      .eq("user_id", userId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(40);
    type SessionRow = {
      topic: string | null;
      created_at: string;
      questions: Array<{ stem?: string; bloom_level?: string }> | null;
    };
    const rows = (sessions as SessionRow[] | null) || [];
    for (const s of rows) {
      // Session-level topic filter.
      if (topicLower) {
        const st = (s.topic || "").toLowerCase();
        const matches = (st && (st.includes(topicLower) || topicLower.includes(st)));
        if (!matches) continue;
      }
      const ts = new Date(s.created_at).getTime();
      const items = Array.isArray(s.questions) ? s.questions : [];
      for (const q of items) {
        if (!q?.stem || typeof q.stem !== "string") continue;
        if (bloomLevel && q.bloom_level !== bloomLevel) continue;
        collected.push({ stem: q.stem.trim(), createdAt: ts });
      }
    }
  } catch { /* fall through */ }

  // ─── Source 3: daily_drill_attempts.items (Daily Drill) ─────────────
  try {
    const { data: drills } = await sb
      .from("daily_drill_attempts")
      .select("items, created_at")
      .eq("student_id", userId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(40);
    type DrillRow = {
      created_at: string;
      items: Array<{ stem?: string; bloom_level?: string }> | null;
    };
    const rows = (drills as DrillRow[] | null) || [];
    for (const d of rows) {
      const ts = new Date(d.created_at).getTime();
      const items = Array.isArray(d.items) ? d.items : [];
      for (const it of items) {
        if (!it?.stem || typeof it.stem !== "string") continue;
        if (bloomLevel && it.bloom_level && it.bloom_level !== bloomLevel) continue;
        // No topic on this row to filter against; if user supplied a
        // topic we keep the entry anyway and let the consumer Jaccard
        // dedup catch it. The trade-off: more false positives but no
        // false negatives (always over-include for safety).
        if (topicLower && !it.stem.toLowerCase().includes(topicLower)) {
          // Soft filter: only keep if topic word appears in stem.
          // Avoids polluting with unrelated topics.
          continue;
        }
        collected.push({ stem: it.stem.trim(), createdAt: ts });
      }
    }
  } catch { /* fall through */ }

  // ─── Dedupe by exact stem, sort newest-first, slice to limit ────────
  const seen = new Set<string>();
  collected.sort((a, b) => b.createdAt - a.createdAt);
  const out: string[] = [];
  for (const entry of collected) {
    if (seen.has(entry.stem)) continue;
    seen.add(entry.stem);
    out.push(entry.stem);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Concept extraction (Layer 3) ────────────────────────────────────────

/**
 * Pull the top topic-concept tokens by frequency across the stem list.
 * Drops stopwords, drops short tokens, lowercases, keeps the densest
 * words that actually carry topic signal.
 *
 * Returns Array<string>. Empty when there are no stems or no signal.
 */
function topConceptsFromStems(stems: string[]): string[] {
  if (stems.length === 0) return [];
  const counts = new Map<string, number>();
  for (const stem of stems) {
    const tokens = stem
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= MIN_CONCEPT_TOKEN_LENGTH && !STOPWORDS.has(t));
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2 || stems.length === 1) // a token has to recur unless we only have 1 stem to lean on
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_CONCEPTS_TO_SURFACE)
    .map(([t]) => t);
}

// ─── Prompt formatting ──────────────────────────────────────────────────

/**
 * Build the prompt-ready exclusion block. Empty string when there's
 * nothing to exclude — callers concatenate this onto their SYSTEM or
 * USER prompt unconditionally.
 *
 * Structure (when non-empty):
 *
 *   STRICT NON-REPETITION RULE — the student has already answered these
 *   questions in recent tests on this topic. Generate fundamentally
 *   DIFFERENT questions — different sub-concepts, different scenarios,
 *   different formulas — not paraphrases of these:
 *     1. "<stem>"
 *     2. "<stem>"
 *     ...
 *
 *   Concepts already covered (don't reuse as the central focus):
 *   chlorophyll, light, calvin, atp, electron, photon
 *
 *   Pick OTHER aspects of the topic for this batch.
 */
function buildPromptBlock(stems: string[], concepts: string[]): string {
  if (stems.length === 0) return "";
  const numbered = stems.map((s, i) => `  ${i + 1}. "${s.replace(/"/g, '\\"')}"`).join("\n");
  const conceptLine = concepts.length > 0
    ? `\n\nConcepts already covered (don't reuse as the central focus): ${concepts.join(", ")}.\n` +
      `Pick OTHER aspects of the topic for this batch.`
    : "";
  return (
    `\n\nSTRICT NON-REPETITION RULE — the student has already answered these ` +
    `questions in recent tests on this topic. Generate fundamentally DIFFERENT ` +
    `questions — different sub-concepts, different scenarios, different formulas — ` +
    `not paraphrases of these:\n${numbered}` +
    conceptLine
  );
}

// ─── Public entry point ─────────────────────────────────────────────────

/**
 * One-shot: fetch the student's recent stems + concepts + ready-to-paste
 * prompt block. Every question-generation endpoint should call this
 * exactly once at the top of its request handler.
 *
 * @param sb         supabaseAdmin client
 * @param userId     caller auth user id
 * @param topic      user-typed topic (free text)
 * @param bloomLevel optional Bloom-level filter — when set, exclusion
 *                   only considers stems answered at the same level.
 *                   Pass null when generating across multiple levels.
 * @param limit      max stems to surface (default 20)
 */
export async function getRecentStemsForExclusion(
  sb: SupabaseClient,
  userId: string,
  topic: string,
  bloomLevel: BloomLevel | null,
  limit: number = DEFAULT_LIMIT,
): Promise<ExclusionPayload> {
  const stems = await fetchRecentSeenStems(sb, userId, topic, bloomLevel, limit);
  const conceptsAlreadyCovered = topConceptsFromStems(stems);
  const promptBlock = buildPromptBlock(stems, conceptsAlreadyCovered);
  return { stems, conceptsAlreadyCovered, promptBlock };
}
