// lib/embeddings.ts
// =============================================================================
// Semantic embedding helper — Gemini text-embedding-004 (768-dim).
// -----------------------------------------------------------------------------
// Why this exists
// ---------------
// The existing dedup uses Jaccard on uppercased token sets. That catches
// near-identical wording but completely misses paraphrases:
//   "How does HCl ionise in water?" vs "Explain dissociation of hydrochloric acid"
//   → Jaccard ~0.10 (one shared token). Cosine on embeddings ~0.85.
// With this helper a paraphrase pair gets caught BEFORE it reaches the
// student.
//
// Model choice — Gemini text-embedding-004
// ----------------------------------------
// - Free tier on AI Studio (1500 RPM).
// - 768-dim output, matches the vector(768) column in migration 80.
// - Quality on par with OpenAI text-embedding-3-small for English content.
// - The user already has GEMINI_API_KEY configured (no new env var).
//
// Returns null on any failure so callers can fall back gracefully — a
// missing embedding should NEVER break generation, only weaken dedup.
// =============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";

const EMBED_MODEL = "text-embedding-004";
// F93 note (QA): EMBED_DIM is hardcoded to match Gemini text-embedding-004.
// If Google ships a model with different dimensions, embedTexts will
// silently return null and dedup falls back to Jaccard. Bump both
// constants together; never split.
// F93 note (QA): EMBED_DIM is hardcoded to match Gemini text-embedding-004.
// If Google ships a model with different dimensions, embedTexts will
// silently return null and dedup falls back to Jaccard. Bump both
// constants together; never split.
const EMBED_DIM = 768;

let _client: GoogleGenerativeAI | null = null;
function client(): GoogleGenerativeAI | null {
  if (_client) return _client;
  const key = process.env.GEMINI_API_KEY || "";
  if (!key) return null;
  _client = new GoogleGenerativeAI(key);
  return _client;
}

/** Single-text embedding. Returns null on any failure. */
export async function embedText(text: string): Promise<number[] | null> {
  const t = (text || "").trim();
  if (!t) return null;
  const c = client();
  if (!c) return null;
  try {
    const model = c.getGenerativeModel({ model: EMBED_MODEL });
    const res = await model.embedContent(t);
    const vec = res.embedding?.values;
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) return null;
    return vec;
  } catch {
    return null;
  }
}

/** Batch embedding. Returns an array (same length, null on per-item failure)
 *  or `null` if the whole call failed. Caller treats null as "no embeddings
 *  available — use Jaccard fallback".
 *
 *  Capped at MAX_EMBED_BATCH inputs and CHUNK_SIZE concurrent requests so a
 *  pathological caller (or future caller passing 100+ stems) doesn't burst
 *  past Gemini's 1500 RPM free tier. Over-cap inputs return as null for
 *  the tail entries — callers already treat null as "fall back to Jaccard". */
const MAX_EMBED_BATCH = 32;
const EMBED_CHUNK_SIZE = 8;
export async function embedTexts(texts: string[]): Promise<(number[] | null)[] | null> {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const c = client();
  if (!c) return null;
  const safeInputs = texts.slice(0, MAX_EMBED_BATCH);
  const overflow = texts.length - safeInputs.length;
  // F79 fix: log when we silently drop excess inputs so callers can
  // see they need to chunk upstream. The truncation was previously
  // invisible — caller got nulls back and assumed Jaccard fallback.
  if (overflow > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[embeddings] embedTexts received ${texts.length} inputs; capped at ${MAX_EMBED_BATCH}. Last ${overflow} got null embeddings.`,
    );
  }
  try {
    const model = c.getGenerativeModel({ model: EMBED_MODEL });
    // Chunked parallelism — at most EMBED_CHUNK_SIZE in flight at any
    // time, then move to the next chunk. Stops free-tier 429s on bursts.
    const out: (number[] | null)[] = [];
    for (let i = 0; i < safeInputs.length; i += EMBED_CHUNK_SIZE) {
      const chunk = safeInputs.slice(i, i + EMBED_CHUNK_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (raw) => {
          const t = (raw || "").trim();
          if (!t) return null;
          try {
            const res = await model.embedContent(t);
            const vec = res.embedding?.values;
            if (!Array.isArray(vec) || vec.length !== EMBED_DIM) return null;
            return vec;
          } catch {
            return null;
          }
        }),
      );
      out.push(...chunkResults);
    }
    // Pad with null so the returned array length still matches the
    // caller's input length — keeps index-based zip-style consumers safe.
    for (let i = 0; i < overflow; i++) out.push(null);
    return out;
  } catch {
    return null;
  }
}

/** Cosine similarity on two equal-length vectors. Returns 0 on length mismatch. */
export function cosineSim(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Filter candidate stems against a history set using cosine similarity.
 * Returns the kept indices (callers map back to their candidate array).
 *
 * Caller responsibility: provide candidates with their embeddings already
 * computed. The history side can be passed as raw vectors (e.g. fetched
 * via the `stem_embedding` column in the DB).
 *
 * Threshold defaults to 0.85. Higher = more lenient (only the closest
 * paraphrases get dropped). Lower = more aggressive (more variety, more
 * false-positive drops). 0.85 is the sweet spot for English MCQ stems
 * in our experiments.
 */
export function cosineDedupAgainstHistory(
  candidates: Array<{ embedding: number[] | null }>,
  historyEmbeddings: number[][],
  threshold = 0.85,
): { keptIndices: number[]; droppedIndices: number[] } {
  const kept: number[] = [];
  const dropped: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i].embedding;
    if (!e) {
      // No embedding for this candidate — defer to upstream Jaccard.
      kept.push(i);
      continue;
    }
    let maxSim = 0;
    for (const h of historyEmbeddings) {
      const s = cosineSim(e, h);
      if (s > maxSim) maxSim = s;
      if (maxSim >= threshold) break;
    }
    if (maxSim >= threshold) {
      dropped.push(i);
    } else {
      kept.push(i);
    }
  }
  return { keptIndices: kept, droppedIndices: dropped };
}

/**
 * Additionally dedup candidates AGAINST EACH OTHER (in-batch dedup).
 * Greedy: keep the first, then keep each subsequent only if max-sim to
 * any already-kept is below threshold.
 */
export function cosineDedupInBatch(
  candidates: Array<{ embedding: number[] | null }>,
  threshold = 0.85,
): { keptIndices: number[]; droppedIndices: number[] } {
  const kept: number[] = [];
  const dropped: number[] = [];
  const keptVecs: number[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i].embedding;
    if (!e) {
      kept.push(i);
      continue;
    }
    let maxSim = 0;
    for (const k of keptVecs) {
      const s = cosineSim(e, k);
      if (s > maxSim) maxSim = s;
      if (maxSim >= threshold) break;
    }
    if (maxSim >= threshold) {
      dropped.push(i);
    } else {
      kept.push(i);
      keptVecs.push(e);
    }
  }
  return { keptIndices: kept, droppedIndices: dropped };
}

export const EMBEDDING_DIM = EMBED_DIM;
