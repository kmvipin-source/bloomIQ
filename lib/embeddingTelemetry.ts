// lib/embeddingTelemetry.ts
// =============================================================================
// Embedding-failure visibility (P3.11).
// -----------------------------------------------------------------------------
// Why
// ---
// embedTexts() in lib/embeddings.ts returns null mid-batch when the
// Gemini API rate-limits us, the network blips, or a per-item embedding
// fails. Today that silent null cascades through the dedup pipeline —
// rows lose their stem_embedding, cosine dedup degrades to Jaccard, the
// student sees a paraphrase the next day, and we have no signal that
// anything went wrong.
//
// This module wraps embedTexts() with two outputs callers can act on:
//   1. A counter of how many embeddings came back null in this batch.
//   2. A "should we surface a quiet UI banner?" flag — true when the
//      failure rate crosses a threshold high enough that history dedup
//      will be measurably weaker for THIS batch.
//
// The pipeline (lib/qgenPipeline.ts) already reads embedTexts() directly;
// routes that haven't migrated yet can use embedTextsWithTelemetry() as
// a drop-in replacement to surface visibility incrementally.
// =============================================================================

import { embedTexts } from "@/lib/embeddings";

export type EmbeddingTelemetry = {
  /** Length of the input (request) array. */
  requested: number;
  /** How many came back as a real vector. */
  succeeded: number;
  /** How many came back null (per-item failure). */
  failed: number;
  /** True when the WHOLE call returned null (Gemini key missing or
   *  transport failed); the batch falls back fully to Jaccard. */
  totalFailure: boolean;
  /** 0..1 — `failed / requested`. 0 when totalFailure (we treat that
   *  separately so the UI can show a more specific message). */
  failureRate: number;
  /** True when the UI should show "semantic dedup unavailable / weakened
   *  this run — questions may repeat" badge. Fires above 25% failure
   *  OR on totalFailure. */
  surfaceBanner: boolean;
};

const SURFACE_THRESHOLD = 0.25;

/**
 * Drop-in for embedTexts() that returns the vectors PLUS a telemetry
 * blob the route can include in its response.
 *
 * @example
 *   const { vectors, telemetry } = await embedTextsWithTelemetry(stems);
 *   if (telemetry.surfaceBanner) {
 *     response.embedding_warning = "Semantic dedup degraded this run.";
 *   }
 */
export async function embedTextsWithTelemetry(
  texts: string[],
): Promise<{ vectors: (number[] | null)[]; telemetry: EmbeddingTelemetry }> {
  const requested = texts.length;
  if (requested === 0) {
    return {
      vectors: [],
      telemetry: {
        requested: 0,
        succeeded: 0,
        failed: 0,
        totalFailure: false,
        failureRate: 0,
        surfaceBanner: false,
      },
    };
  }

  const result = await embedTexts(texts);
  if (result === null) {
    // Total failure — Gemini key missing or transport failed for the
    // whole call. Emit a single telemetry line so we can grep logs for
    // sustained failures.
    // eslint-disable-next-line no-console
    console.warn(
      `[embeddingTelemetry] total failure on ${requested} texts — semantic dedup unavailable for this batch`,
    );
    return {
      vectors: texts.map(() => null),
      telemetry: {
        requested,
        succeeded: 0,
        failed: requested,
        totalFailure: true,
        failureRate: 0, // sentinel: read totalFailure first
        surfaceBanner: true,
      },
    };
  }

  let succeeded = 0;
  for (const v of result) if (v) succeeded++;
  const failed = requested - succeeded;
  const failureRate = requested === 0 ? 0 : failed / requested;

  if (failureRate >= SURFACE_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn(
      `[embeddingTelemetry] elevated failure rate ${(failureRate * 100).toFixed(0)}% (${failed}/${requested}) — semantic dedup degraded`,
    );
  }

  return {
    vectors: result,
    telemetry: {
      requested,
      succeeded,
      failed,
      totalFailure: false,
      failureRate,
      surfaceBanner: failureRate >= SURFACE_THRESHOLD,
    },
  };
}

/**
 * Human-readable message for the UI to show when telemetry.surfaceBanner
 * is true. The string is intentionally calm — embedding failure is a
 * quality degradation, not a generation failure. Students still get
 * questions; they may just see a paraphrase from last week.
 */
export function embeddingBannerMessage(t: EmbeddingTelemetry): string {
  if (t.totalFailure) {
    return "Semantic dedup is temporarily unavailable — questions in this batch were filtered with the basic word-overlap check only. If you see repetition, generate a second batch and we'll filter against this one.";
  }
  if (t.surfaceBanner) {
    const pct = Math.round(t.failureRate * 100);
    return `Semantic dedup was weakened this run (${pct}% of embeddings unavailable). A small chance of question repetition.`;
  }
  return "";
}
