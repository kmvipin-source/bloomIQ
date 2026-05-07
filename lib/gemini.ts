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

export const GEMINI_MODEL = "gemini-2.0-flash-exp";

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

export async function geminiJSON(systemPrompt: string, userPrompt: string) {
  if (!client) throw new Error("Gemini not configured (set GEMINI_API_KEY).");
  const model = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.4,
    },
  });
  const res = await model.generateContent(userPrompt);
  const text = res.response.text() || "{}";
  return parseJsonLoose(text);
}
