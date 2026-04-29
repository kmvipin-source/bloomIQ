import type { ExamPaperQuestion, ExamQuestionType } from "@/lib/types";
import { groqJSON } from "@/lib/groq";

/**
 * Normalise a fill-blank / numerical answer for comparison: trim, lowercase,
 * collapse internal whitespace.
 */
export function normaliseAnswer(s: string | null | undefined): string {
  if (!s) return "";
  return s.toString().trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map an MCQ correct_answer (which may be "A"/"B"/.. or 0..3) to a 0-based
 * option index. Returns -1 if it cannot be parsed.
 */
export function correctMcqIndex(correct: string | null | undefined): number {
  if (correct == null) return -1;
  const raw = correct.toString().trim();
  if (!raw) return -1;
  // Accept "A", "a", "0", "1", etc.
  const upper = raw.toUpperCase();
  if (upper.length === 1 && upper >= "A" && upper <= "Z") {
    return upper.charCodeAt(0) - 65;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n < 26) return Math.floor(n);
  return -1;
}

export type StudentAnswerInput = {
  paper_question_id: string;
  selected_index?: number | null;
  answer_text?: string | null;
};

export type ScoredAnswer = {
  paper_question_id: string;
  selected_index: number | null;
  answer_text: string | null;
  is_correct: boolean | null;
  marks_awarded: number;
  ai_feedback: string | null;
  bloom_level: string | null;
};

const FREE_TEXT_TYPES: ExamQuestionType[] = ["short_answer", "long_answer"];

/**
 * Synchronously score a single answer for the deterministic question types
 * (mcq, true_false, fill_blank, numerical). Free-text types return null
 * for is_correct so the caller can run an async AI pass.
 */
export function scoreDeterministic(
  q: ExamPaperQuestion,
  ans: StudentAnswerInput
): ScoredAnswer {
  const base: ScoredAnswer = {
    paper_question_id: q.id,
    selected_index: ans.selected_index ?? null,
    answer_text: ans.answer_text ?? null,
    is_correct: null,
    marks_awarded: 0,
    ai_feedback: null,
    bloom_level: q.bloom_level,
  };

  switch (q.question_type) {
    case "mcq": {
      const correctIdx = correctMcqIndex(q.correct_answer);
      const selected = ans.selected_index ?? -1;
      const ok = correctIdx >= 0 && selected === correctIdx;
      return { ...base, is_correct: ok, marks_awarded: ok ? q.marks : 0 };
    }
    case "true_false": {
      const correct = normaliseAnswer(q.correct_answer);
      const given = normaliseAnswer(ans.answer_text);
      const ok = !!given && correct === given;
      return { ...base, is_correct: ok, marks_awarded: ok ? q.marks : 0 };
    }
    case "fill_blank":
    case "numerical": {
      const correct = normaliseAnswer(q.correct_answer);
      const given = normaliseAnswer(ans.answer_text);
      // For numerical, also accept stripping trailing units; cheap heuristic.
      let ok = !!given && correct === given;
      if (!ok && q.question_type === "numerical" && given && correct) {
        const stripUnits = (s: string) => s.replace(/[^0-9.\-]/g, "");
        const a = stripUnits(given);
        const b = stripUnits(correct);
        if (a && b && a === b) ok = true;
      }
      return { ...base, is_correct: ok, marks_awarded: ok ? q.marks : 0 };
    }
    case "short_answer":
    case "long_answer":
      // Defer to AI grader — caller will overwrite.
      return base;
  }
}

export function isFreeText(q: ExamPaperQuestion): boolean {
  return FREE_TEXT_TYPES.includes(q.question_type);
}

/**
 * AI-grade a single free-text answer. Returns marks_awarded, is_correct,
 * and short feedback. Robust to malformed model JSON.
 */
export async function aiGradeFreeText(
  q: ExamPaperQuestion,
  studentAnswer: string
): Promise<{ marks_awarded: number; is_correct: boolean; ai_feedback: string }> {
  if (!studentAnswer || !studentAnswer.trim()) {
    return {
      marks_awarded: 0,
      is_correct: false,
      ai_feedback: "No answer was provided.",
    };
  }
  const sys = `You are a strict but fair examiner grading a student's answer. Return STRICT JSON only.
The schema is:
{
  "marks_awarded": <number 0..max_marks, may be a half-mark>,
  "is_correct": <true if marks_awarded >= 0.6 * max_marks else false>,
  "feedback": "<one or two short sentences of feedback for the student>"
}`;
  const user = `Question: ${q.stem}

Model answer / answer key:
"""${q.correct_answer || "(not provided — judge using subject knowledge)"}"""

Maximum marks: ${q.marks}

Student's answer:
"""${studentAnswer.slice(0, 4000)}"""

Grade the student's answer. Be lenient on phrasing but strict on factual content. Return JSON only.`;

  try {
    const out = await groqJSON(sys, user) as Record<string, unknown>;
    const rawMarks = Number(out.marks_awarded ?? 0);
    const max = q.marks;
    const marks = Number.isFinite(rawMarks) ? Math.max(0, Math.min(max, rawMarks)) : 0;
    const isCorrect = marks >= 0.6 * max;
    const fb = typeof out.feedback === "string" ? out.feedback : "";
    return {
      marks_awarded: marks,
      is_correct: isCorrect,
      ai_feedback: fb || "Graded by AI.",
    };
  } catch (e) {
    return {
      marks_awarded: 0,
      is_correct: false,
      ai_feedback: `AI grading failed: ${e instanceof Error ? e.message : "unknown"}. Teacher review recommended.`,
    };
  }
}

/**
 * Run an async worker pool of size `concurrency` over `items`, calling `task`
 * for each. Preserves input order in the result.
 */
export async function workerPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          results[i] = await task(items[i], i);
        }
      })()
    );
  }
  await Promise.all(workers);
  return results;
}
