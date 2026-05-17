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

// Finding #84 fix: distinct parse-error type, mirroring GroqParseError.
// The old parseJsonLoose returned {} silently on malformed output, so
// downstream callers couldn\'t tell apart "AI succeeded with empty output"
// from "AI returned garbage". Now we throw — callers either handle it or
// surface a real 502.
export class GeminiParseError extends Error {
  raw: string;
  constructor(raw: string) {
    super("Gemini returned non-JSON output.");
    this.name = "GeminiParseError";
    this.raw = raw;
  }
}

function parseJsonStrict(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    throw new GeminiParseError(text.slice(0, 200));
  }
}

// Token caps (Finding #85 + #86). Mirror the values from lib/groq.ts so
// Gemini doesn\'t blow past Groq\'s response budget and slow down or rack
// up cost when the fallback fires.
const MAX_OUTPUT_TOKENS_JSON = 4500;
const MAX_OUTPUT_TOKENS_TEXT = 1600;

// Finding #87: per-request timeout. Without this, a hung Gemini call
// occupies the Vercel lambda for its full maxDuration. Cap at 30s
// (same as the Groq client).
const GEMINI_TIMEOUT_MS = 30_000;

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
  // Finding #87: wrap in Promise.race so a hung Gemini connection can\'t
  // burn the lambda\'s full maxDuration.
  const timeoutP = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`Gemini timed out after ${GEMINI_TIMEOUT_MS / 1000}s`)), GEMINI_TIMEOUT_MS),
  );
  const res = await Promise.race([model.generateContent(userPrompt), timeoutP]);
  return res.response.text() || "";
}

export async function geminiJSON(systemPrompt: string, userPrompt: string) {
  // Finding #85: added maxOutputTokens cap to keep response size + latency
  // comparable to Groq\'s 4500-token cap. Without it, Gemini could run up
  // to its 8k+ default ceiling, slowing fallbacks and bumping cost.
  const cfg = { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: MAX_OUTPUT_TOKENS_JSON };
  try {
    const text = await generateOnce(GEMINI_MODEL, systemPrompt, userPrompt, cfg);
    // Finding #84: parseJsonStrict throws GeminiParseError on malformed
    // output instead of silently returning {}.
    return parseJsonStrict(text || "{}");
  } catch (e) {
    // 2.5 might be region-gated for some accounts; retry on 2.0-flash so
    // the feature still works for them.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[gemini] primary model failed, falling back to", GEMINI_MODEL_FALLBACK, e);
    }
    const text = await generateOnce(GEMINI_MODEL_FALLBACK, systemPrompt, userPrompt, cfg);
    return parseJsonStrict(text || "{}");
  }
}

/**
 * Plain-text generation. Used by the visualizer's Stage A "plan the
 * diagram in prose" pass before the Stage B JSON conversion. Plan-then-
 * execute is documented to improve LLM spatial reasoning vs. one-shot
 * JSON for the same prompt — and the plan also serves as a debug log.
 */
export async function geminiText(systemPrompt: string, userPrompt: string) {
  // Finding #86: maxOutputTokens cap mirroring lib/groq.ts.
  const cfg = { temperature: 0.5, maxOutputTokens: MAX_OUTPUT_TOKENS_TEXT };
  try {
    return await generateOnce(GEMINI_MODEL, systemPrompt, userPrompt, cfg);
  } catch {
    return await generateOnce(GEMINI_MODEL_FALLBACK, systemPrompt, userPrompt, cfg);
  }
}
