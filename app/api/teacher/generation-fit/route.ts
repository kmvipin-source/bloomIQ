// app/api/teacher/generation-fit/route.ts
// =============================================================================
// Generate-time difficulty fit check.
//
// Purpose
// -------
// The teacher composer (and any future generation surface) calls this BEFORE
// kicking off an AI generation to detect "I'm asking for JEE questions for my
// Class 5-8 students" mismatches. Cheap, fast, no AI cost — pure SQL +
// in-process rule evaluation.
//
// Why a dedicated endpoint instead of the existing /api/teacher/class-fit?
// class-fit looks at HISTORICAL attempt data on EXISTING questions. This
// endpoint answers a different question: "given that I'm about to GENERATE
// questions at difficulty X for class Y, is the match sensible?" — no
// attempt data needed, just the slugs.
//
// Two call modes:
//   1. ?class_id=...&target_category=...
//      Caller supplies a real class — we resolve the class's grade to a
//      slug and validate against target_category.
//   2. ?class_category=...&target_category=...
//      Caller supplies both slugs directly (used by surfaces that don't
//      have a class context — e.g. teacher generating personal practice
//      that they'll later assign).
//
// Auth: teacher must be authenticated; class_id mode additionally checks
// they teach that class (class_teachers join).
// =============================================================================

import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import {
  classGradeToCategory,
  validateGenerationFit,
  type GenerationFitResult,
} from "@/lib/questionCategory";

export const runtime = "nodejs";

type ClassRow = { id: string; grade: string | null };
type ClassTeacherRow = { user_id: string };

function emptyResult(reason: string): GenerationFitResult & { ok: true; reason: string } {
  return {
    ok: true,
    reason,
    severity: "none",
    message: "",
    rankGap: 0,
    classLabel: "",
    targetLabel: "",
  };
}

export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const url = new URL(req.url);
    const classId = url.searchParams.get("class_id");
    const directClassCategory = url.searchParams.get("class_category");
    const targetCategory = url.searchParams.get("target_category");

    if (!targetCategory) {
      return NextResponse.json(
        { error: "target_category is required" },
        { status: 400 },
      );
    }

    let classCategory: string | null = null;

    if (classId) {
      // Verify teacher membership on this class. RLS would also block, but
      // an explicit check gives a 403 instead of a confusing empty result.
      const { data: teaches } = await sb
        .from("class_teachers")
        .select("user_id")
        .eq("class_id", classId)
        .eq("user_id", user.id)
        .limit(1);
      const teachesRows = (teaches as ClassTeacherRow[] | null) || [];
      if (teachesRows.length === 0) {
        return NextResponse.json(
          { error: "You do not teach this class" },
          { status: 403 },
        );
      }
      const { data: cls } = await sb
        .from("classes")
        .select("id, grade")
        .eq("id", classId)
        .maybeSingle();
      const c = cls as ClassRow | null;
      classCategory = classGradeToCategory(c?.grade ?? null);
      if (!classCategory) {
        return NextResponse.json(emptyResult("class_grade_unparseable"));
      }
    } else if (directClassCategory) {
      classCategory = directClassCategory;
    } else {
      // Neither provided → can't validate. Return "none" with reason so
      // the caller can decide whether to surface a hint.
      return NextResponse.json(emptyResult("no_class_context"));
    }

    const fit = validateGenerationFit(classCategory, targetCategory);
    return NextResponse.json({
      ok: true,
      class_category: classCategory,
      target_category: targetCategory,
      ...fit,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[generation-fit] unhandled:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
