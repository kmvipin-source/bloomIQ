// lib/audienceLevel.ts
// -----------------------------------------------------------------------------
// Three-level audience signal for the AI question generator (Beginner /
// Practitioner / Expert) PLUS a "no preference" null state (2026-05-13 evening).
//
// The chip is fully optional. When the user hasn't picked, resolveAudienceLevel
// returns level=null and promptFragment="" — the route then omits any audience
// instruction from the LLM prompt entirely, letting the model use its own
// judgment. This avoids surprising users who didn't ask for a depth control.
// =============================================================================

export type AudienceLevel = "beginner" | "practitioner" | "expert";

export const AUDIENCE_LEVELS: readonly AudienceLevel[] = ["beginner", "practitioner", "expert"] as const;

/** Strict parser. Returns the level if valid, null otherwise. */
export function parseAudienceLevel(raw: unknown): AudienceLevel | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "beginner" || s === "practitioner" || s === "expert") return s;
  return null;
}

/** Short, behavioural prompt fragment for each audience level. */
export function audiencePromptFragment(level: AudienceLevel): string {
  switch (level) {
    case "beginner":
      return [
        "Audience: BEGINNER. The learner is new to this topic.",
        "Prefer single-concept questions with one mental step.",
        "Use plain language and avoid jargon unless the term is the answer itself.",
        "Definitions, direct recall, simple identifications, and short application are appropriate.",
        "Do NOT write trick questions, multi-step derivations, or edge-case gotchas.",
      ].join(" ");
    case "practitioner":
      return [
        "Audience: PRACTITIONER. The learner has working knowledge of this topic.",
        "Prefer multi-step application, real-world scenarios, and common pitfall identification.",
        "Use domain vocabulary without re-defining it.",
        "Questions should test 'can you actually use this?' not 'do you remember the definition?'.",
      ].join(" ");
    case "expert":
      return [
        "Audience: EXPERT. The learner is advanced and wants edge cases.",
        "Prefer subtle distinctions, performance trade-offs, debugging-style framings,",
        "and questions where two answers look equally correct until you read carefully.",
        "Real-world gotchas, lesser-known specifics, and synthesis across sub-areas are encouraged.",
      ].join(" ");
  }
}

/**
 * Resolve a user-provided audience-level value into a strict shape.
 * Returns level=null + empty fragment when the user hasn't picked.
 * No profile-driven default — the section is fully opt-in.
 */
export function resolveAudienceLevel(
  rawFromBody: unknown,
): { level: AudienceLevel | null; wasExplicit: boolean; promptFragment: string } {
  const parsed = parseAudienceLevel(rawFromBody);
  if (parsed) return { level: parsed, wasExplicit: true, promptFragment: audiencePromptFragment(parsed) };
  return { level: null, wasExplicit: false, promptFragment: "" };
}
