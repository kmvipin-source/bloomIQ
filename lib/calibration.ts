// BloomIQ — Empirical question calibration (light IRT).
// SERVER-ONLY: imports supabaseAdmin and must never be bundled into the client.
//
// Once a question accumulates >= minAttempts attempts we compute:
//   - calibrated_difficulty (0..1): proportion correct (higher = easier).
//   - calibrated_discrimination (-1..1): point-biserial correlation between
//     is_correct on this question and the student's overall ability
//     (mean score / total across all their attempts).
//   - calibrated_attempts: number of attempts the calibration is based on.
//   - calibrated_at: timestamp of the latest calibration run.
//
// For questions with < minAttempts we still update calibrated_attempts so the
// UI can render a "needs more data" chip; the two coefficient columns stay null.

import { supabaseAdmin } from "./supabase/server";

export type CalibrationResult = {
  question_id: string;
  attempts: number;
  difficulty: number;          // 0..1
  discrimination: number;       // -1..1
  meets_min_attempts: boolean;
};

// =============================================================================
// pointBiserial
// -----------------------------------------------------------------------------
// Standard point-biserial correlation:
//   r_pb = (M1 - M0) / Sd * sqrt(p * q)
// where:
//   M1 = mean of `continuous` values where `binary` is true
//   M0 = mean of `continuous` values where `binary` is false
//   p  = proportion of `binary` that is true
//   q  = 1 - p
//   Sd = population standard deviation of `continuous` (n, not n-1)
//
// Edge cases — return 0 when r_pb is undefined:
//   p === 0  -> all false, can't compute M1
//   p === 1  -> all true, can't compute M0
//   Sd === 0 -> no variance in ability
// =============================================================================
export function pointBiserial(binary: boolean[], continuous: number[]): number {
  if (binary.length !== continuous.length || binary.length === 0) return 0;

  const n = binary.length;
  let trueCount = 0;
  let sum1 = 0;
  let sum0 = 0;
  let totalSum = 0;

  for (let i = 0; i < n; i++) {
    const v = continuous[i];
    totalSum += v;
    if (binary[i]) {
      trueCount++;
      sum1 += v;
    } else {
      sum0 += v;
    }
  }

  const p = trueCount / n;
  const q = 1 - p;
  if (p === 0 || p === 1) return 0;

  const m1 = sum1 / trueCount;
  const m0 = sum0 / (n - trueCount);
  const mean = totalSum / n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = continuous[i] - mean;
    variance += d * d;
  }
  variance /= n; // population variance (use n)
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;

  return ((m1 - m0) / sd) * Math.sqrt(p * q);
}

// =============================================================================
// interpretDifficulty / interpretDiscrimination
// -----------------------------------------------------------------------------
// Pure helpers — also re-exported from lib/calibrationView.ts for client use
// without dragging server deps into the bundle.
// =============================================================================
export function interpretDifficulty(d: number | null): "easy" | "medium" | "hard" | "unknown" {
  if (d === null || d === undefined || Number.isNaN(d)) return "unknown";
  if (d >= 0.75) return "easy";
  if (d >= 0.40) return "medium";
  return "hard";
}

export function interpretDiscrimination(r: number | null): "good" | "weak" | "broken" | "unknown" {
  if (r === null || r === undefined || Number.isNaN(r)) return "unknown";
  if (r >= 0.30) return "good";
  if (r >= 0.10) return "weak";
  return "broken";
}

// =============================================================================
// computeCalibrationForOwner
// -----------------------------------------------------------------------------
// Walks every question in the owner's bank, pulls each question's attempt
// answers joined to the student's overall ability, and writes calibration
// columns. Skips questions with fewer than `minAttempts` attempts (default 20)
// but still records calibrated_attempts so the UI can show progress.
// =============================================================================
type AttemptRow = {
  is_correct: boolean | null;
  quiz_attempts: {
    student_id: string | null;
    score: number | null;
    total: number | null;
  } | null;
};

export async function computeCalibrationForOwner(
  ownerId: string,
  opts?: { minAttempts?: number }
): Promise<{ updated: number; skipped: number }> {
  const minAttempts = opts?.minAttempts ?? 20;
  const sb = supabaseAdmin();

  // 1) Fetch all question ids owned by this user. We don't filter by status —
  //    even pending/rejected items can be calibrated if attempts exist.
  const { data: qs, error: qErr } = await sb
    .from("question_bank")
    .select("id")
    .eq("owner_id", ownerId);
  if (qErr) throw qErr;
  const questionIds: string[] = (qs ?? []).map((r: { id: string }) => r.id);

  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const qid of questionIds) {
    // 2) Pull every attempt_answer for this question, joined with the parent
    //    quiz_attempt so we get the student's score / total for ability.
    const { data: rows, error: aErr } = await sb
      .from("attempt_answers")
      .select("is_correct, quiz_attempts!inner(student_id, score, total)")
      .eq("question_id", qid);
    if (aErr) throw aErr;

    const answers = (rows ?? []) as unknown as AttemptRow[];

    // 3) Filter to attempts with total > 0 so ability = score/total is defined.
    const isCorrect: boolean[] = [];
    const ability: number[] = [];
    let correctCount = 0;
    for (const r of answers) {
      const a = r.quiz_attempts;
      if (!a) continue;
      const total = a.total ?? 0;
      if (total <= 0) continue;
      const score = a.score ?? 0;
      const ic = !!r.is_correct;
      isCorrect.push(ic);
      ability.push(score / total);
      if (ic) correctCount++;
    }

    const attempts = isCorrect.length;

    if (attempts < minAttempts) {
      // Still record the count so the UI can show "Calibrating: x / 20".
      const { error: uErr } = await sb
        .from("question_bank")
        .update({
          calibrated_attempts: attempts,
          calibrated_difficulty: null,
          calibrated_discrimination: null,
          calibrated_at: now,
        })
        .eq("id", qid);
      if (uErr) throw uErr;
      skipped++;
      continue;
    }

    const difficulty = correctCount / attempts;
    const discrimination = pointBiserial(isCorrect, ability);

    const { error: uErr } = await sb
      .from("question_bank")
      .update({
        calibrated_attempts: attempts,
        calibrated_difficulty: difficulty,
        calibrated_discrimination: discrimination,
        calibrated_at: now,
      })
      .eq("id", qid);
    if (uErr) throw uErr;
    updated++;
  }

  return { updated, skipped };
}
