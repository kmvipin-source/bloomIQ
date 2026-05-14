// lib/topicGrounding.ts
// =============================================================================
// Dynamic LLM-driven topic decomposition for world-class question generation.
// -----------------------------------------------------------------------------
// Why this exists
// ---------------
// Before 2026-05-14 evening, niche-topic quality relied on a hand-curated
// few-shot bank (lib/skillFewShot.ts). That approach is inherently brittle —
// every topic the curator hasn't seen produces vague questions. Modern
// LLM-powered question apps solve this with a two-stage pipeline:
//
//   Stage 1 (this module): one cheap LLM call decomposes the topic into
//     the canonical sub-areas, real-world anchors, and common misconceptions
//     that a knowledgeable instructor would have in mind before writing
//     questions. ZERO local knowledge required — the LLM does the
//     decomposition because it's the only thing that knows the topic.
//
//   Stage 2 (the per-level generator): receives this grounding alongside
//     the topic and uses it to (a) cover the topic broadly instead of
//     repeating one angle, (b) anchor stems in real terminology rather
//     than fabricating, (c) base distractors on the listed misconceptions.
//
// This is what makes a generator world-class on ARBITRARY topics — no
// maintained list, no "topic isn't in our database" failure mode. The
// LLM grounds itself.
//
// Cost: one extra Groq call per generation (~50-150 tokens out). Cached
// in-memory per-request so the 6 per-level calls don't each pay for it.
// =============================================================================

import { groqJSON } from "@/lib/groq";

export type TopicGrounding = {
  /** Canonical sub-areas / sub-topics a knowledgeable instructor would
   *  cover when teaching this topic. 6-10 entries. Used by the generator
   *  to spread questions across the topic instead of clustering on one
   *  angle. Each entry is a short noun phrase (≤8 words). */
  subAreas: string[];

  /** Specific real-world anchors: named standards, products, parameters,
   *  field numbers, regulatory clauses, named theorems, real syntax —
   *  whatever a real-world question would cite. 4-8 entries. The
   *  generator is instructed to USE these (not invent alternatives). */
  realWorldAnchors: string[];

  /** Common student misconceptions / wrong-but-plausible beliefs about
   *  this topic. 3-6 entries. The generator turns these into PLAUSIBLE
   *  distractors — which is what separates real exam questions from
   *  random-distractor garbage. */
  commonMisconceptions: string[];

  /** One-line description of what a "tough" question on this topic
   *  looks like. Used to push Analyze/Evaluate/Create levels into the
   *  right difficulty register. */
  difficultyAnchor: string;
};

const SYSTEM = `You are an expert curriculum designer profiling a topic before a colleague generates MCQs on it.

Your job: decompose the given topic into the canonical sub-areas, real-world anchors, common student misconceptions, and difficulty anchor that an experienced instructor would have in mind before writing questions.

CRITICAL RULES:
- USE precise real-world terminology of the topic's domain. Real product names, real parameter names, real syntax, real field numbers, real API verbs, real standards, real regulatory clauses, real theorem names, real reaction types — whatever applies.
- NEVER invent identifiers, opcodes, parameters, product features, or syntax that doesn't exist.
- If you have weak knowledge of the topic, be HONEST: return empty arrays for the parts you're unsure of. The downstream generator handles partial grounding gracefully.
- Common misconceptions should be SPECIFIC wrong beliefs students hold — not just "they confuse X with Y" but "students often think X does Z, when it actually does W".

Return STRICT JSON only.`;

/**
 * Decompose a topic for the question generator.
 *
 * @param topic         The student's topic input (verbatim).
 * @param context       Optional learner context — if the topic is being
 *                      asked in the context of a specific exam goal
 *                      (jee_main, neet_prep, cat_prep, etc.) or learner
 *                      profile (k12, competitive_exam, corporate), pass
 *                      it so the grounding is calibrated to that audience.
 * @returns             TopicGrounding on success, null on any failure
 *                      (caller falls back to ungrounded generation).
 */
export async function groundTopic(
  topic: string,
  context?: { examGoal?: string | null; learnerProfile?: string | null },
): Promise<TopicGrounding | null> {
  const t = (topic || "").trim();
  if (t.length < 3 || t.length > 200) return null;

  const audience = context?.examGoal
    ? `The student is preparing for ${context.examGoal} — calibrate sub-areas and difficulty to that exam's actual coverage.`
    : context?.learnerProfile === "corporate"
      ? "The learner is a working professional — anchor in industry-applied scenarios, not textbook recall."
      : context?.learnerProfile === "competitive_exam"
        ? "The student is preparing for a competitive exam — emphasise Apply / Analyze depth and exam-paper register."
        : context?.learnerProfile === "k12"
          ? "The student is in K-12 — anchor in NCERT / board-textbook concepts at an age-appropriate depth."
          : "No specific learner context — give broad, generally useful coverage.";

  const userPrompt = `Topic the student typed: "${t}"
Audience context: ${audience}

Return JSON with this exact shape:
{
  "subAreas": [
    "6-10 canonical sub-areas of this topic. Short noun phrases (≤8 words each).",
    "Example for 'Human Intestine': 'Small intestine anatomy', 'Villi and microvilli', 'Absorption mechanisms', 'Brush border enzymes', 'Hormonal control of digestion', 'Common pathologies (IBS, IBD, malabsorption)'."
  ],
  "realWorldAnchors": [
    "4-8 specific real-world references the generator should USE.",
    "Examples: named theorems ('Henderson-Hasselbalch equation'), real product features ('Postilion source interface'), real regulatory clauses ('PCI-DSS Requirement 8.2.3'), real syntax ('JCL COND=(0,LT)'), real anatomical structures ('crypts of Lieberkühn'), real standards ('ISO 8583 DE-39')."
  ],
  "commonMisconceptions": [
    "3-6 specific WRONG beliefs students hold. Each is a complete misconception sentence the generator can build a distractor around.",
    "Example for 'Human Intestine': 'Students often think most water absorption happens in the small intestine, but it's actually the large intestine'."
  ],
  "difficultyAnchor": "One sentence describing what a TOUGH question on this topic looks like — what cognitive move makes it hard. e.g. 'Tough questions require multi-step physiological reasoning across two organ systems (e.g. how renal failure alters intestinal calcium absorption).'"
}

If your knowledge of this topic is weak, return empty arrays rather than fabricating.`;

  try {
    const raw = await groqJSON(SYSTEM, userPrompt);
    const r = (raw || {}) as Record<string, unknown>;
    const subAreas = Array.isArray(r.subAreas)
      ? (r.subAreas as unknown[]).map(String).filter((s) => s.trim().length > 0).slice(0, 12)
      : [];
    const realWorldAnchors = Array.isArray(r.realWorldAnchors)
      ? (r.realWorldAnchors as unknown[]).map(String).filter((s) => s.trim().length > 0).slice(0, 10)
      : [];
    const commonMisconceptions = Array.isArray(r.commonMisconceptions)
      ? (r.commonMisconceptions as unknown[]).map(String).filter((s) => s.trim().length > 0).slice(0, 8)
      : [];
    const difficultyAnchor = typeof r.difficultyAnchor === "string" ? r.difficultyAnchor.trim() : "";

    // If the LLM gave us nothing useful, return null so callers can fall
    // back to ungrounded generation. Threshold: at least 3 sub-areas OR
    // 3 anchors. Below that the grounding adds noise more than signal.
    if (subAreas.length < 3 && realWorldAnchors.length < 3) return null;

    return { subAreas, realWorldAnchors, commonMisconceptions, difficultyAnchor };
  } catch {
    return null;
  }
}

/**
 * Format a TopicGrounding for injection into a question-generator SYSTEM
 * prompt. Returns "" when ground is null so callers can unconditionally
 * concat.
 */
export function formatGroundingForPrompt(ground: TopicGrounding | null): string {
  if (!ground) return "";
  const parts: string[] = ["\n\nTOPIC GROUNDING (use these to anchor your questions — DO NOT invent alternatives):"];

  if (ground.subAreas.length > 0) {
    parts.push("\nSub-areas to spread questions across (cover at least 3 different ones in this batch):");
    ground.subAreas.forEach((s, i) => parts.push(`  ${i + 1}. ${s}`));
  }
  if (ground.realWorldAnchors.length > 0) {
    parts.push("\nReal-world anchors you SHOULD reference (real names, real syntax, real standards):");
    ground.realWorldAnchors.forEach((a, i) => parts.push(`  ${i + 1}. ${a}`));
  }
  if (ground.commonMisconceptions.length > 0) {
    parts.push("\nCommon student misconceptions — use these as PLAUSIBLE distractors instead of random wrong answers:");
    ground.commonMisconceptions.forEach((m, i) => parts.push(`  ${i + 1}. ${m}`));
  }
  if (ground.difficultyAnchor) {
    parts.push(`\nTough-question shape: ${ground.difficultyAnchor}`);
  }
  parts.push("");
  return parts.join("\n");
}
