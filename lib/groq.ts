import Groq from "groq-sdk";

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

export async function groqJSON(systemPrompt: string, userPrompt: string) {
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
}

export async function groqJSONVision(
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string
) {
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
}

export default groqClient;
