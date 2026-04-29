import { groqJSON } from "./groq";

export type Classification = {
  subject: string | null;
  topic_family: string | null;
};

const SYSTEM = `You are a curriculum classifier. You group similar topics together
under canonical "topic family" names so that progress can be compared across
related quizzes. Return STRICT JSON only.`;

/**
 * Classify a quiz into a canonical (subject, topic_family) pair.
 *
 * The grounding list of `existingFamilies` is critical for consistency —
 * when present, the model is asked to REUSE one of those exact names if the
 * new content is even loosely related. This is what makes "Apple anatomy"
 * and "Apple varieties" both fall under "Apples" instead of fragmenting.
 */
export async function classifyQuiz(
  topic: string,
  sampleStems: string[],
  existingFamilies: string[] = []
): Promise<Classification> {
  const familiesHint = existingFamilies.length
    ? `

The user has already used these topic families. STRONGLY PREFER reusing one of
these EXACT names if the new content is even loosely related. Group naturally —
e.g. "Apple anatomy", "Apple varieties", and "Apples in nutrition" all belong
under "Apples"; "World War 2 causes" and "Allied strategy 1944" both belong
under "World War II".

Existing families:
${existingFamilies.slice(0, 50).map((f) => `  - ${f}`).join("\n")}

Only invent a NEW family name if none of the above is a reasonable fit.`
    : "";

  const user = `Classify this quiz.

Topic provided by user: ${topic || "(not provided)"}
Sample question stems:
${sampleStems.slice(0, 3).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

Return JSON of the form:
{
  "subject": "Broad academic subject in Title Case (e.g. 'Biology', 'World History', 'Mathematics', 'Computer Science', 'General Knowledge').",
  "topic_family": "A short, CANONICAL sub-topic family name in Title Case. Be concise and groupable. Examples: 'Photosynthesis', 'Apples', 'World War II', 'Linear Equations', 'Cell Biology'."
}${familiesHint}`;

  try {
    const res = await groqJSON(SYSTEM, user);
    const subject = typeof res.subject === "string" && res.subject.trim() ? res.subject.trim() : null;
    const topic_family = typeof res.topic_family === "string" && res.topic_family.trim() ? res.topic_family.trim() : null;
    return { subject, topic_family };
  } catch {
    return { subject: null, topic_family: null };
  }
}
