import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { computeCalibrationForOwner } from "@/lib/calibration";

export const runtime = "nodejs";
export const maxDuration = 120;

// =============================================================================
// POST /api/qbank/calibrate
// -----------------------------------------------------------------------------
// Recompute empirical difficulty + discrimination for every question in the
// requesting teacher's bank. No body required — owner is the authenticated
// user. Only role IN ('teacher', 'super_teacher') may call this; students
// and other roles get 403.
// =============================================================================
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: prof, error: pErr } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (pErr || !prof) {
      return NextResponse.json({ error: "Profile not found" }, { status: 403 });
    }
    if (prof.role !== "teacher" && prof.role !== "super_teacher") {
      return NextResponse.json(
        { error: "Only teachers can calibrate the question bank." },
        { status: 403 }
      );
    }

    const { updated, skipped } = await computeCalibrationForOwner(user.id);

    return NextResponse.json({
      updated,
      skipped,
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Calibration failed." },
      { status: 500 }
    );
  }
}

// =============================================================================
// GET /api/qbank/calibrate
// -----------------------------------------------------------------------------
// Read-only fetch of the current calibration state for the owner's bank.
// Useful for refreshing badges without recomputing. If migration 18 hasn't
// been applied yet (calibration columns don't exist), we return an empty
// items array rather than 500 — the UI is designed to degrade gracefully.
// =============================================================================
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: prof } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!prof || (prof.role !== "teacher" && prof.role !== "super_teacher")) {
      return NextResponse.json(
        { error: "Only teachers can view bank calibration." },
        { status: 403 }
      );
    }

    const admin = supabaseAdmin();
    const sel = await admin
      .from("question_bank")
      .select("id, calibrated_difficulty, calibrated_discrimination, calibrated_attempts, calibrated_at")
      .eq("owner_id", user.id);

    if (sel.error) {
      // Likely cause: migration 18 not yet applied. Return empty list.
      if (/column.+calibrated_/i.test(sel.error.message)) {
        return NextResponse.json({ items: [] });
      }
      throw sel.error;
    }

    type Row = {
      id: string;
      calibrated_difficulty: number | null;
      calibrated_discrimination: number | null;
      calibrated_attempts: number | null;
      calibrated_at: string | null;
    };
    const items = ((sel.data ?? []) as Row[]).map((r) => ({
      question_id: r.id,
      calibrated_difficulty: r.calibrated_difficulty,
      calibrated_discrimination: r.calibrated_discrimination,
      calibrated_attempts: r.calibrated_attempts,
      calibrated_at: r.calibrated_at,
    }));

    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read calibration." },
      { status: 500 }
    );
  }
}
