import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import {
  consumeLifetimeUse,
  type LifetimeFeature,
} from "@/lib/freeQuota";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

// =============================================================================
// POST /api/feature/touch
// -----------------------------------------------------------------------------
// Body: { key: LifetimeFeature }
//
// Records that the user has "tasted" a lifetime-once feature whose work
// happens entirely client-side (e.g. Voice AI Teacher, which uses the
// browser's Web Speech API plus /api/tutor/chat — there's no dedicated
// backend route to gate).
//
// The PAGE for these features calls this endpoint on first interaction
// (the "Start listening" button click, for example). The first call
// succeeds and records the touch; subsequent calls return 402 so the
// client can render the upgrade prompt.
//
// Paid users always succeed and never record a row.
//
// Accepted keys are limited to features whose primary work isn't already
// gated server-side. We allow the full LifetimeFeature union for
// flexibility — callers should not abuse this to fake usage.
// =============================================================================

// Phase H: restricted to features that DON'T have a dedicated server
// route. Allowing the full LifetimeFeature union let a logged-in user
// pre-burn any of their lifetime slots via this cheap endpoint, e.g. to
// grief their own quota or test bypasses. Each server-gated feature
// now claims its own slot via consumeLifetimeUse inside its own route.
const ALLOWED_KEYS: LifetimeFeature[] = [
  "voice_teacher",
];

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rate = checkRateLimit(user.id, "feature.touch", { capacity: 5, refillPerHour: 20 });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many requests.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const key = String(body.key || "") as LifetimeFeature;
    if (!ALLOWED_KEYS.includes(key)) {
      return NextResponse.json({ error: "Unknown feature key." }, { status: 400 });
    }

    const gate = await consumeLifetimeUse(user.id, key);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason, code: "free_lifetime_used" },
        { status: 402 }
      );
    }

    return NextResponse.json({ ok: true, key });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Feature touch failed" },
      { status: 500 }
    );
  }
}
