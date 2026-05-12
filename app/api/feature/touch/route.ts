import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import {
  checkLifetimeUse,
  recordLifetimeUse,
  type LifetimeFeature,
} from "@/lib/freeQuota";

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

const ALLOWED_KEYS: LifetimeFeature[] = [
  "voice_teacher",
  // Other lifetime features are gated at their own backend routes; touching
  // them via this endpoint is allowed but redundant. We don't reject so the
  // client UX stays simple.
  "xray",
  "rank",
  "visualizer",
  "trap_detector",
  "knowledge_graph",
  "bloom_score",
];

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const key = String(body.key || "") as LifetimeFeature;
    if (!ALLOWED_KEYS.includes(key)) {
      return NextResponse.json({ error: "Unknown feature key." }, { status: 400 });
    }

    const gate = await checkLifetimeUse(user.id, key);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason, code: "free_lifetime_used" },
        { status: 402 }
      );
    }

    await recordLifetimeUse(user.id, key);

    return NextResponse.json({ ok: true, key });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Feature touch failed" },
      { status: 500 }
    );
  }
}
