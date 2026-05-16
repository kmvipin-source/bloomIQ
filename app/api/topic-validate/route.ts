// app/api/topic-validate/route.ts
// =============================================================================
// LLM-based topic-vs-exam-syllabus alignment validator.
// -----------------------------------------------------------------------------
// Replaces the brittle keyword-list approach (lib/examDetectors.EXAM_SUBJECT_KEYWORDS)
// that kept producing false positives like "Blood Group → suggested CAT for a
// NEET student" because keyword sets can never enumerate every legitimate
// topic of every syllabus. The LLM already knows what's on each exam — ask it.
//
// Behaviour
// ---------
// Given (topic, examName, examDescription, examSections), returns:
//   { valid: bool, reason: string, suggestedExam: string | null }
//
// "valid" is LENIENT — if a topic could plausibly relate to the exam (broad
// terms, foundational concepts, sub-topics under a canonical section), it
// returns true. Reserve "invalid" for topics that are clearly off-syllabus.
//
// "suggestedExam" — when invalid, names which well-known exam (from a fixed
// list) the topic does fit, or null if none fits. The student-facing UI uses
// this to offer a one-click "switch your goal" hint to Settings.
//
// Failure mode
// ------------
// On any error (network, LLM timeout, malformed response) we return
// `{ valid: true, reason: "validator_unavailable", suggestedExam: null }` —
// fail-open. A false warning is worse than a missed warning here; the user
// can always proceed and judge the generated test themselves.
// =============================================================================

import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 15;

const SYSTEM = `You are a competitive-exam syllabus validator for a test-prep app.

Given the topic a student typed AND the exam they're preparing for, decide
whether the topic belongs to that exam's syllabus or is close enough that
exam-style questions on it make sense.

Be LENIENT. If the topic could plausibly relate (broad terms, foundational
concepts, sub-topics under a canonical section, named theorems / models /
phenomena that appear in the syllabus), mark valid. Reserve invalid for
topics that are clearly off-syllabus — e.g. "history" for NEET, "biology"
for CAT, "Java programming" for UPSC.

When invalid, ALSO suggest which well-known exam the topic does fit (from
the fixed list below) so the UI can offer a "switch goal" hint. Use the
exam's display name exactly as listed. Use null when no listed exam fits.

Allowed values for suggestedExam:
  "JEE Main / JEE Advanced"
  "NEET"
  "CAT"
  "UPSC CSE Prelims"
  "GMAT"
  "GRE"
  "GATE"
  "CLAT"
  "BITSAT"
  "SAT"
  "NDA"
  "CUET (UG)"
  "IELTS"
  "TOEFL"
  null

Return STRICT JSON only — no markdown, no preamble.`;

type ValidationResult = {
  valid: boolean;
  reason: string;
  suggestedExam: string | null;
};

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // Cheap LLM call but a bored or buggy client could hammer it. Tight
    // per-user rate limit; on hit return a fail-open response so the UI
    // stays silent rather than blocking generation.
    const rate = checkRateLimit(user.id, "topic-validate", {
      capacity: 15,
      refillPerHour: 90,
    });
    if (!rate.allowed) {
      return NextResponse.json<ValidationResult>({
        valid: true,
        reason: "rate_limited",
        suggestedExam: null,
      });
    }

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").trim().slice(0, 200);
    const examName: string = String(body.examName || "").trim().slice(0, 120);
    // Length cap on examDescription / examSections too — client-supplied
    // fields flow straight into the LLM prompt. Without caps a crafted
    // description string is a prompt-injection vector. 600 chars is well
    // above any legitimate exam description in EXAM_DETECTORS.
    const examDescription: string = String(body.examDescription || "").trim().slice(0, 600);
    const examSectionsRaw: unknown = body.examSections;
    const examSections: string[] = Array.isArray(examSectionsRaw)
      ? (examSectionsRaw as unknown[]).map((x) => String(x).slice(0, 120)).slice(0, 12)
      : [];

    if (!topic || !examName) {
      return NextResponse.json<ValidationResult>({
        valid: true,
        reason: "missing_input",
        suggestedExam: null,
      });
    }
    if (topic.length < 3 || topic.length > 200) {
      return NextResponse.json<ValidationResult>({
        valid: true,
        reason: "topic_length",
        suggestedExam: null,
      });
    }

    const userPrompt = `Exam: ${examName}
${examDescription ? `Description: ${examDescription}` : ""}
${examSections.length ? `Canonical sections: ${examSections.join(", ")}` : ""}

Topic the student typed: "${topic}"

Question: Is this topic on the syllabus of this exam (or closely related)?

Examples to anchor your judgment:
- topic="blood group", exam=NEET → {"valid": true, "reason": "Blood groups are part of NEET Biology (human physiology).", "suggestedExam": null}
- topic="history", exam=NEET → {"valid": false, "reason": "History isn't on the NEET medical syllabus.", "suggestedExam": "UPSC CSE Prelims"}
- topic="thermodynamics", exam=CAT → {"valid": false, "reason": "Thermodynamics is physics, not a CAT subject.", "suggestedExam": "JEE Main / JEE Advanced"}
- topic="bohr model", exam=JEE → {"valid": true, "reason": "Bohr's atomic model is part of JEE Physics (modern physics).", "suggestedExam": null}
- topic="reading comprehension", exam=CAT → {"valid": true, "reason": "Reading Comprehension is a core CAT VARC section.", "suggestedExam": null}
- topic="ancient india", exam=UPSC → {"valid": true, "reason": "Ancient Indian history is on the UPSC Prelims GS syllabus.", "suggestedExam": null}
- topic="java programming", exam=NEET → {"valid": false, "reason": "Programming languages aren't on the NEET medical syllabus.", "suggestedExam": null}
- topic="propitiate", exam=GRE → {"valid": true, "reason": "Vocabulary words like this are core GRE Verbal.", "suggestedExam": null}
- topic="blood relation", exam=CAT → {"valid": true, "reason": "Blood relation puzzles are part of CAT Logical Reasoning.", "suggestedExam": null}

Return JSON of the exact shape:
{
  "valid": boolean,
  "reason": "one-sentence plain-English explanation",
  "suggestedExam": "<one of the listed exam names>" | null
}`;

    const raw = await groqJSON(SYSTEM, userPrompt);
    const r = (raw || {}) as Record<string, unknown>;
    const valid = typeof r.valid === "boolean" ? r.valid : true; // fail-open
    const reason = typeof r.reason === "string" ? r.reason.trim() : "";
    const suggestedExam =
      typeof r.suggestedExam === "string" && r.suggestedExam.trim().length > 0
        ? r.suggestedExam.trim()
        : null;

    return NextResponse.json<ValidationResult>({
      valid,
      reason,
      suggestedExam,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[topic-validate] failed — fail-open:",
      e instanceof Error ? e.message : e,
    );
    return NextResponse.json<ValidationResult>({
      valid: true,
      reason: "validator_unavailable",
      suggestedExam: null,
    });
  }
}
