// Lightweight per-user, per-route rate limiter for cost-sensitive LLM
// endpoints. Token-bucket model — every call costs 1 token, the bucket
// refills at `refillPerHour` until it's full again. Implemented in
// process memory because Vercel Fluid Compute reuses function instances
// across invocations: each instance throttles its own traffic share, so
// at worst an attacker spreads across instances and gets ~N× the cap.
// Good enough for an honest-actor abuse deterrent; a distributed
// limiter (Upstash, Redis) is a follow-up if real abuse appears.
//
// NOT a fairness limit. Hard cap a single client's call rate before we
// hand the request to Groq / Gemini / Razorpay. Independent of plan
// gates — a Premium user still gets capped at the route's rate.

type Bucket = {
  tokens: number;
  lastRefill: number;
};

type Config = {
  // Maximum tokens the bucket holds — the burst size a user can fire
  // before being throttled.
  capacity: number;
  // How many tokens get added back per hour. capacity / refillPerHour
  // gives the steady-state "1 call every X minutes" budget.
  refillPerHour: number;
};

const STATE = new Map<string, Bucket>();

function take(key: string, cfg: Config): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const now = Date.now();
  let b = STATE.get(key);
  if (!b) {
    b = { tokens: cfg.capacity, lastRefill: now };
    STATE.set(key, b);
  }
  // Refill based on elapsed time.
  const elapsedMs = now - b.lastRefill;
  if (elapsedMs > 0) {
    const refill = (elapsedMs / 3_600_000) * cfg.refillPerHour;
    b.tokens = Math.min(cfg.capacity, b.tokens + refill);
    b.lastRefill = now;
  }
  if (b.tokens < 1) {
    const needed = 1 - b.tokens;
    const retryAfterMs = (needed / cfg.refillPerHour) * 3_600_000;
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  b.tokens -= 1;
  return { allowed: true };
}

/**
 * Check whether `userId` is within the budget for `routeKey`. Returns
 * an object with `allowed: true` when the call may proceed, or
 * `allowed: false` + `retryAfterSec` when the bucket is empty.
 *
 * Callers should respond with HTTP 429 + Retry-After header on a deny.
 *
 * Default config is calibrated for typical LLM-backed routes: 20-burst,
 * 60 refill/hour (≈ 1/min steady-state). Pass an explicit config for
 * cheap or expensive routes.
 */
export function checkRateLimit(
  userId: string,
  routeKey: string,
  config?: Partial<Config>
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const cfg: Config = {
    capacity: config?.capacity ?? 20,
    refillPerHour: config?.refillPerHour ?? 60,
  };
  return take(`${userId}:${routeKey}`, cfg);
}

// Daily counter (resets at UTC midnight) — used for expensive surfaces
// like vision (xray, image-based generate, papers/generate from image).
// Stored in the same process map, so same caveat as the token bucket.
const DAILY = new Map<string, { count: number; dayKey: string }>();
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function checkDailyCap(
  userId: string,
  routeKey: string,
  limit: number
): { allowed: true; used: number; limit: number } | { allowed: false; used: number; limit: number } {
  const k = `${userId}:${routeKey}`;
  const day = todayKey();
  let row = DAILY.get(k);
  if (!row || row.dayKey !== day) {
    row = { count: 0, dayKey: day };
    DAILY.set(k, row);
  }
  if (row.count >= limit) return { allowed: false, used: row.count, limit };
  row.count += 1;
  return { allowed: true, used: row.count, limit };
}
