// One-call gate for cost-sensitive LLM endpoints. Combines:
//   1. Bearer-token auth (every LLM route must require a signed-in caller)
//   2. Per-user, per-route token-bucket rate limit
//   3. Optional plan-feature gate via lib/featureAccess.server
//   4. Optional per-day cap on top of the bucket (for expensive surfaces
//      like vision)
//
// Usage at the top of a route handler:
//
//   const gate = await aiGate(req, {
//     route: "tutor.chat",
//     feature: "ai_tutor",           // optional
//     rateLimit: { capacity: 30, refillPerHour: 60 },
//     dailyCap: 100,                  // optional
//   });
//   if (!gate.ok) return gate.response;
//   const userId = gate.userId;
//
// On a deny the helper returns a fully-formed NextResponse — the route
// just needs to forward it. Never throws.

import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit, checkDailyCap } from "@/lib/rateLimit";
import { requireFeature } from "@/lib/featureAccess.server";

export type AiGateOptions = {
  route: string;
  feature?: string;
  rateLimit?: { capacity?: number; refillPerHour?: number };
  dailyCap?: number;
};

export type AiGateResult =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

export async function aiGate(req: Request, opts: AiGateOptions): Promise<AiGateResult> {
  const token = getBearer(req);
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  // Plan-feature gate first — a Free user hitting a Plus-only route
  // should see a 403 with a useful upgrade message before we burn a
  // rate-limit token.
  if (opts.feature) {
    const featureGate = await requireFeature(user.id, opts.feature);
    if (!featureGate.allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: featureGate.reason,
            code: "plan_required",
            required_tier: featureGate.requiredTier,
          },
          { status: 403 }
        ),
      };
    }
  }

  // Token bucket — burst-tolerant short-term limit.
  const rate = checkRateLimit(user.id, opts.route, opts.rateLimit);
  if (!rate.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Too many requests. Slow down a moment.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } }
      ),
    };
  }

  // Daily ceiling — abuse safety net for expensive routes.
  if (typeof opts.dailyCap === "number" && opts.dailyCap > 0) {
    const daily = checkDailyCap(user.id, opts.route, opts.dailyCap);
    if (!daily.allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `Daily limit reached (${daily.limit}). Try again tomorrow.`,
            code: "daily_cap",
            used: daily.used,
            limit: daily.limit,
          },
          { status: 429 }
        ),
      };
    }
  }

  return { ok: true, userId: user.id };
}
