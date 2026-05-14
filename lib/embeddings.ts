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
 *  available — use Jaccard fallback". */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[] | null> {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const c = client();
  if (!c) return null;
  try {
    const model = c.getGenerativeModel({ model: EMBED_MODEL });
    // The Google SDK supports per-call embedding; we issue them in parallel.
    // For very large batches we'd need to chunk + rate-limit, but our typical
    // batch is ≤ 20 stems per generation, well below Gemini's free-tier RPM.
    const out: (number[] | null)[] = await Promise.all(
      texts.map(async (raw) => {
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

/** The embedding dimension the rest of the app should assume. */
export const EMBEDDING_DIM = EMBED_DIM;
