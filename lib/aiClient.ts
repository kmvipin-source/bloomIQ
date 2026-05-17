// lib/aiClient.ts
// =============================================================================
// Unified AI client with Groq-primary, Gemini-fallback.
//
// Wraps groq.ts (`groqJSON`, `groqText`) so every caller automatically falls
// over to Gemini when Groq returns 429 (daily token cap exhausted) or 5xx.
// No call-site changes — replace `import { groqJSON } from "@/lib/groq"` with
// `import { aiJSON } from "@/lib/aiClient"` and you're done.
//
// Why this exists:
//   Groq's free tier has a 100k-tokens-per-day cap. With 100+ pilot users on
//   AI-heavy features (Teach-Back, Misconception, Generate, Tutor), the cap
//   is reachable in production. Without a fallback, AI features silently
//   fail mid-session.
//
// Behavior:
//   - Try Groq first (fast, free).
//   - On 429 (rate-limited) -> fall through to Gemini.
//   - On 5xx -> fall through to Gemini.
//   - On other errors (4xx other than 429, parse errors) -> rethrow.
//
// Observability: every fallback is logged via console.warn so production can
// alert when Groq is saturated.
// =============================================================================

import { groqJSON, groqText, GroqParseError } from "@/lib/groq";
import { geminiJSON, geminiText, isGeminiConfigured } from "@/lib/gemini";

type GroqHttpError = Error & {
  status?: number;
  code?: string | number;
};

/**
 * Best-effort detection: is this error a Groq rate-limit / capacity issue
 * we should retry via Gemini? Groq SDK throws errors with `status` or `code`
 * on HTTP failures; we check both.
 */
function isRetryableViaFallback(err: unknown): boolean {
  if (err instanceof GroqParseError) return false;  // parse error = bad output, fallback won't help
  if (!err || typeof err !== "object") return false;
  const e = err as GroqHttpError;
  // Numeric status code
  if (typeof e.status === "number") {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
  }
  // String code (some SDKs use string codes)
  if (typeof e.code === "string") {
    const c = e.code.toLowerCase();
    if (c.includes("rate") || c.includes("429") || c.includes("timeout")) return true;
  }
  // Message-based heuristic (last resort)
  if (e instanceof Error) {
    const m = e.message.toLowerCase();
    if (m.includes("rate limit") || m.includes("rate_limit") || m.includes("429")) return true;
    if (m.includes("daily") && m.includes("limit")) return true;
  }
  return false;
}

/**
 * Drop-in replacement for groqJSON. Falls back to Gemini on 429/5xx.
 * Same input contract (system + user prompt strings) and output contract
 * (parsed JSON object).
 */
export async function aiJSON(systemPrompt: string, userPrompt: string): Promise<unknown> {
  try {
    return await groqJSON(systemPrompt, userPrompt);
  } catch (err) {
    if (!isRetryableViaFallback(err)) throw err;
    if (!isGeminiConfigured()) {
      // No fallback configured — rethrow original error so caller can show
      // a meaningful "AI service temporarily unavailable" message.
      console.warn("[aiClient] Groq failed and GEMINI_API_KEY not set — no fallback available.", err);
      throw err;
    }
    console.warn("[aiClient] Groq failed (likely rate limit). Falling back to Gemini.", err instanceof Error ? err.message : err);
    return await geminiJSON(systemPrompt, userPrompt);
  }
}

/**
 * Drop-in replacement for groqText. Same fallback semantics as aiJSON.
 */
export async function aiText(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    return await groqText(systemPrompt, userPrompt);
  } catch (err) {
    if (!isRetryableViaFallback(err)) throw err;
    if (!isGeminiConfigured()) {
      console.warn("[aiClient] Groq failed and GEMINI_API_KEY not set — no fallback available.", err);
      throw err;
    }
    console.warn("[aiClient] Groq failed (likely rate limit). Falling back to Gemini.", err instanceof Error ? err.message : err);
    return await geminiText(systemPrompt, userPrompt);
  }
}

/**
 * Convenience: report which providers are configured. Useful for /api/healthz
 * to surface AI capacity in the status page.
 */
export function aiProvidersStatus(): { groq: boolean; gemini: boolean } {
  return {
    groq: !!(process.env.GROQ_API_KEY),
    gemini: isGeminiConfigured(),
  };
}
