import { GoogleGenerativeAI } from "@google/generative-ai";

// Server-side only. Do NOT prefix the env var with NEXT_PUBLIC_*.
//
// Why Gemini in addition to Groq:
//   The Concept Visualizer's quality is dominated by the spatial reasoning
//   of the LLM that emits the JSON keyframes. Groq llama-3.3 is fast and
//   free, but its spatial layout is weak — overlapping shapes, drifting
//   labels, formulas that don't fit. Gemini 2.0/2.5 Flash gives a much
//   tighter scene plan for the same prompt and is free up to 1500 req/day
//   on the public AI Studio tier. We keep Groq as a fallback so a missing
//   GEMINI_API_KEY doesn't break the feature in dev.
const apiKey = process.env.GEMINI_API_KEY || "";
const client = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// 2.5 Flash is the current free-tier flagship on AI Studio (15 RPM, 1500
// req/day) and gives meaningfully better spatial layout for the keyframe
// JSON than 2.0-flash-exp. We default to it and fall back to 2.0-flash if
// 2.5 ever 404s the model name.
export const GEMINI_MODEL = "gemini-2.5-flash";
export const GEMINI_MODEL_FALLBACK = "gemini-2.0-flash";

export function isGeminiConfigured(): boolean {
  return !!client;
}

function parseJsonLoose(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return {};
  }
}

async function generateOnce(
  modelName: string,
  systemPrompt: string,
  userPrompt: string,
  generationConfig: Record<string, unknown>,
): Promise<string> {
  if (!client) throw new Error("Gemini not configured (set GEMINI_API_KEY).");
  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig,
  });
  const res = await model.generateContent(userPrompt);
  return res.response.text() || "";
}

export async function geminiJSON(systemPrompt: string, userPrompt: string) {
  const cfg = { responseMimeType: "application/json", temperature: 0.4 };
  try {
    const text = await generateOnce(GEMINI_MODEL, systemPrompt, userPrompt, cfg);
    return parseJsonLoose(text || "{}");
  } catch (e) {
    // 2.5 might be region-gated for some accounts; retry on 2.0-flash so
    // the feature still works for them.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[gemini] primary model failed, falling back to", GEMINI_MODEL_FALLBACK, e);
    }
    const text = await generateOnce(GEMINI_MODEL_FALLBACK, systemPrompt, userPrompt, cfg);
    return parseJsonLoose(text || "{}");
  }
}

/**
 * Plain-text generation. Used by the visualizer's Stage A "plan the
 * diagram in prose" pass before the Stage B JSON conversion. Plan-then-
 * execute is documented to improve LLM spatial reasoning vs. one-shot
 * JSON for the same prompt — and the plan also serves as a debug log.
 */
export async function geminiText(systemPrompt: string, userPrompt: string) {
  const cfg = { temperature: 0.5 };
  try {
    return await generateOnce(GEMINI_MODEL, systemPrompt, userPrompt, cfg);
  } catch {
    return await generateOnce(GEMINI_MODEL_FALLBACK, systemPrompt, userPrompt, cfg);
  }
}
