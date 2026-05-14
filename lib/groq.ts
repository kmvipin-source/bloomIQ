import Groq from "groq-sdk";
import {
  GoogleGenerativeAI,
  type GenerativeModel,
} from "@google/generative-ai";

// Server-side only. Do NOT use the NEXT_PUBLIC_* prefix — Next.js inlines
// any NEXT_PUBLIC_* var as a build-time constant into the client bundle,
// which would leak this Groq API key to anyone with browser DevTools.
// The fallback to NEXT_PUBLIC_GROQ_API_KEY exists only to ease migration
// for older deployments; remove the fallback once every .env has the
// non-public name in place.
let _groqClient: Groq | null = null;
function groqClient(): Groq {
  if (_groqClient) return _groqClient;
  _groqClient = new Groq({
    apiKey:
      process.env.GROQ_API_KEY ||
      process.env.NEXT_PUBLIC_GROQ_API_KEY ||
      "",
    // 30s default timeout — chat.completions can hang on Groq edge issues
    // and we don't want a single request to keep a Vercel lambda hot
    // past its 60s/90s limit. Callers can still set route-level
    // maxDuration; this is the per-API-call upper bound.
    timeout: 30_000,
  });
  return _groqClient;
}

// Gemini free-tier fallback. Activates when the Groq call throws a
// rate-limit / quota / 429 error, OR when the env explicitly forces
// Gemini-first via LLM_PROVIDER=gemini. Falls back per-call (NOT a
// process-wide flip) so a brief Groq outage doesn't pin us to Gemini.
//
// 2.5 Flash on AI Studio's free tier gives 15 RPM + 1500 req/day —
// enough headroom to absorb a 40-tester pilot when Groq's free-tier
// daily cap is hit. Same JSON-output shape so callers don't change.
let _geminiClient: GoogleGenerativeAI | null = null;
function geminiClient(): GoogleGenerativeAI | null {
  if (_geminiClient) return _geminiClient;
  const key = process.env.GEMINI_API_KEY || "";
  if (!key) return null;
  _geminiClient = new GoogleGenerativeAI(key);
  return _geminiClient;
}

const GEMINI_TEXT_MODEL = "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = "gemini-2.0-flash";

export const GROQ_MODEL = "llama-3.3-70b-versatile";
// Vision-capable model on Groq for multimodal (image) prompts
export const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// Token output caps. Without an explicit max_tokens the model can emit
// up to the per-model context limit (~8k for the text model, ~4k for
// vision), each token billed. Real production prompts on this codebase
// never need more than ~2500 tokens of output (a single quiz batch +
// explanations). Cap conservatively.
const MAX_OUTPUT_TOKENS_JSON = 2800;
const MAX_OUTPUT_TOKENS_TEXT = 1600;

/**
 * Strict JSON parse. Returns null on malformed output so callers can
 * decide whether to retry vs surface a 502. The previous parseJsonLoose
 * silently returned {} on any failure, causing every caller to think
 * the model returned an empty payload — which then persisted as null/
 * empty rows downstream.
 */
function parseJsonStrict(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract the first {...} block (vision models sometimes wrap JSON in prose)
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class GroqParseError extends Error {
  raw: string;
  constructor(raw: string) {
    super("Model returned non-JSON output.");
    this.name = "GroqParseError";
    this.raw = raw;
  }
}

/**
 * Detect whether an error from the Groq SDK is a rate-limit / quota /
 * "service unavailable" signal. We fall back to Gemini on these; we
 * do NOT fall back on auth errors (bad key), schema errors, or
 * timeouts, because those are likely to repeat on Gemini too.
 */
function shouldFallback(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status === 429 || e.status === 503) return true;
  if (typeof e.code === "string") {
    const c = e.code.toLowerCase();
    if (c.includes("rate") || c.includes("quota") || c.includes("limit")) return true;
  }
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    if (m.includes("rate limit") || m.includes("quota") || m.includes("too many requests") || m.includes("429")) return true;
  }
  return false;
}

/**
 * Should we go to Gemini before Groq for this call?
 *
 * Two trigger paths:
 *  1. Explicit env override LLM_PROVIDER=gemini — set when Groq is down
 *     platform-wide and ops wants to pin everything to Gemini.
 *  2. Auto-detection: GROQ_API_KEY is missing but GEMINI_API_KEY is set.
 *     Added 2026-05-14 after a Gemini-only deployment got 401 from Groq
 *     with no helpful fallback (shouldFallback() deliberately ignores
 *     auth errors). Now we never even attempt Groq when its key isn't
 *     configured — Gemini-only deployments work out of the box.
 *
 * Default: Groq with Gemini fallback on 429/503 (unchanged behaviour
 * for deployments that have both keys set).
 */
function geminiFirst(): boolean {
  if ((process.env.LLM_PROVIDER || "").toLowerCase() === "gemini") return true;
  const hasGroq = !!(process.env.GROQ_API_KEY || process.env.NEXT_PUBLIC_GROQ_API_KEY);
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (!hasGroq && hasGemini) return true;
  return false;
}

async function geminiGenerate(
  modelName: string,
  systemPrompt: string,
  userPrompt: string,
  cfg: Record<string, unknown>,
): Promise<string> {
  const client = geminiClient();
  if (!client) throw new Error("Gemini not configured (set GEMINI_API_KEY).");
  const model: GenerativeModel = client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig: cfg,
  });
  const res = await model.generateContent(userPrompt);
  return res.response.text() || "";
}

async function geminiJSONFallback(systemPrompt: string, userPrompt: string): Promise<Record<string, unknown>> {
  const cfg = { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: MAX_OUTPUT_TOKENS_JSON };
  let text: string;
  try {
    text = await geminiGenerate(GEMINI_TEXT_MODEL, systemPrompt, userPrompt, cfg);
  } catch {
    text = await geminiGenerate(GEMINI_FALLBACK_MODEL, systemPrompt, userPrompt, cfg);
  }
  const parsed = parseJsonStrict(text || "{}");
  if (parsed === null) throw new GroqParseError(text.slice(0, 200));
  return parsed;
}

async function geminiTextFallback(systemPrompt: string, userPrompt: string): Promise<string> {
  const cfg = { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS_TEXT };
  try {
    return (await geminiGenerate(GEMINI_TEXT_MODEL, systemPrompt, userPrompt, cfg)).trim();
  } catch {
    return (await geminiGenerate(GEMINI_FALLBACK_MODEL, systemPrompt, userPrompt, cfg)).trim();
  }
}

export async function groqJSON(systemPrompt: string, userPrompt: string) {
  // If ops has pinned to Gemini, skip the Groq attempt entirely.
  if (geminiFirst() && geminiClient()) {
    return geminiJSONFallback(systemPrompt, userPrompt);
  }
  try {
    const res = await groqClient().chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.4,
      max_tokens: MAX_OUTPUT_TOKENS_JSON,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const text = res.choices[0]?.message?.content || "{}";
    const parsed = parseJsonStrict(text);
    if (parsed === null) {
      // Caller can catch GroqParseError to retry or surface 502. Returning
      // {} previously masked this as silent bad-data into the DB.
      throw new GroqParseError(text.slice(0, 200));
    }
    return parsed;
  } catch (err) {
    if (shouldFallback(err) && geminiClient()) {
      // eslint-disable-next-line no-console
      console.warn("[groq] rate-limited / 503, falling back to Gemini:", (err as Error)?.message);
      return geminiJSONFallback(systemPrompt, userPrompt);
    }
    throw err;
  }
}

export async function groqJSONVision(
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string
) {
  // No Gemini fallback for vision yet — the Gemini SDK's vision call
  // signature differs (inlineData base64 + mimeType) and our callers
  // already enforce decoded-bytes caps + MIME allowlist. If the user
  // hits Groq's vision rate limit we surface the 429; teachers can
  // retry, and the much smaller call volume on vision endpoints
  // makes a daily-cap hit unlikely in the 40-tester pilot.
  const res = await groqClient().chat.completions.create({
    model: GROQ_VISION_MODEL,
    temperature: 0.4,
    max_tokens: MAX_OUTPUT_TOKENS_JSON,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  const text = res.choices[0]?.message?.content || "{}";
  const parsed = parseJsonStrict(text);
  if (parsed === null) {
    throw new GroqParseError(text.slice(0, 200));
  }
  return parsed;
}

export async function groqText(systemPrompt: string, userPrompt: string) {
  if (geminiFirst() && geminiClient()) {
    return geminiTextFallback(systemPrompt, userPrompt);
  }
  try {
    const res = await groqClient().chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.6,
      max_tokens: MAX_OUTPUT_TOKENS_TEXT,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return res.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    if (shouldFallback(err) && geminiClient()) {
      // eslint-disable-next-line no-console
      console.warn("[groq] rate-limited / 503, falling back to Gemini:", (err as Error)?.message);
      return geminiTextFallback(systemPrompt, userPrompt);
    }
    throw err;
  }
}

export default groqClient;
