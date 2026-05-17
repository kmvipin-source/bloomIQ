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
    // F77 fix (QA): never fall back to NEXT_PUBLIC_GROQ_API_KEY —
    // that prefix causes Next.js to inline the value into the client
    // bundle, leaking the secret to every browser. Server-only name only.
    apiKey: process.env.GROQ_API_KEY || "",
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
// F85 fix (QA): the previous 2800-token cap truncated JSON output on
// batches of 18+ MCQs with explanations, causing GroqParseError. 4500
// covers ~25 questions × 180 tokens; well under the model's 8k context.
const MAX_OUTPUT_TOKENS_JSON = 4500;
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
    // F88 fix: cover more provider-specific phrasings — Groq emits both
    // 'rate_limit_exceeded' and 'overloaded' style messages, and 503s
    // often carry no status code on the SDK error.
    if (
      m.includes("rate limit") ||
      m.includes("rate_limit") ||
      m.includes("quota") ||
      m.includes("too many requests") ||
      m.includes("429") ||
      m.includes("503") ||
      m.includes("overloaded") ||
      m.includes("service unavailable") ||
      m.includes("temporarily unavailable")
    ) return true;
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
  // F77 fix: server-only key only (see groqClient SECURITY note).
  const hasGroq = !!process.env.GROQ_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (!hasGroq && hasGemini) return true;
  return false;
}

// F89 fix (QA): the Gemini SDK call has no per-request timeout.
// A hung Gemini connection occupies the lambda for its full
// maxDuration. Cap at 30s (same as Groq's per-call cap).
const GEMINI_TIMEOUT_MS = 30_000;

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
  const timeoutP = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`Gemini timed out after ${GEMINI_TIMEOUT_MS / 1000}s`)), GEMINI_TIMEOUT_MS),
  );
  const res = await Promise.race([model.generateContent(userPrompt), timeoutP]);
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
  // F84 fix: one automatic retry on parse failure. Groq occasionally
  // emits a truncated JSON when max_tokens hits or under high load;
  // a single replay usually succeeds. Transport / rate-limit errors
  // still hit the Gemini fallback path below.
  async function runOnce(): Promise<Record<string, unknown>> {
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
    if (parsed === null) throw new GroqParseError(text.slice(0, 200));
    return parsed;
  }
  try {
    try {
      return await runOnce();
    } catch (firstErr) {
      if (firstErr instanceof GroqParseError) {
        // eslint-disable-next-line no-console
        console.warn("[groq] parse failure on first attempt; retrying once.");
        return await runOnce();
      }
      throw firstErr;
    }
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
  // hits Groq's vision rate limit we surface the 429.
  //
  // Surface a clear error when the deployment has NO Groq key at all
  // (Gemini-only deploys auto-flip groqJSON / groqText to Gemini, but
  // vision would otherwise quietly 401 from Groq with no helpful
  // signal). Telling callers up-front lets them disable vision UI.
  // F77 fix: server-only key only (see groqClient SECURITY note).
  const hasGroq = !!process.env.GROQ_API_KEY;
  if (!hasGroq) {
    throw new Error("Vision generation requires GROQ_API_KEY. Gemini vision fallback is not wired yet.");
  }
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
