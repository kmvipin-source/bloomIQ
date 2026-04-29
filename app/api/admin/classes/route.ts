import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateQuizCode } from "@/lib/utils";

export const runtime = "nodejs";

// Validation rules for grade and section labels. The UI offers common
// presets in dropdowns plus an "Other (specify)" option for school-specific
// labels (Pre-K, LKG, Saraswati Section, etc.). The server accepts any
// non-empty label up to 30 characters and rejects anything that contains
// characters that would break the canonical name format.
const MAX_LABEL_LEN = 30;
// Reject ASCII control chars and angle brackets; allow everything else.
// Kept simple on purpose so Turbopack's regex parser can't trip on it.
function isCleanLabel(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32) return false;        // control chars
    if (code === 60 || code === 62) return false; // < and > to keep things HTML-safe
  }
  return true;
}

function normaliseLabel(raw: unknown): string {
  return String(raw || "").trim().replace(/\s+/g, " ");
}

function buildCanonicalName(grade: string, section: string): string {
  return `Grade ${grade} \u00b7 Section ${section}`;
}

/**
 * POST /api/admin/classes
 *
 * Principal-only class creation. Body:
 *   { grade: string, section: string }
 *
 * Grade and section are free-form labels (the UI offers presets like 1..12
 * and A..H but lets the Admin Head type "Pre-K" or "Saraswati" via "Other").
 * No primary teacher is required at creation — class structure is set up
 * first, teachers are assigned later via a separate action.
 *
 * Auth: caller must be the Admin Head (super_teacher) with a school. Duplicate detection
 * is SCHOOL-WIDE and case-insensitive: no two classes in the same school
 * can share the same (grade, section) label pair.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 1) Caller must be the Admin Head (super_teacher) with a school.
    const { data: me } = await sb
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .single();
    if (!me || me.role !== "super_teacher") {
      return NextResponse.json(
        { error: "Only your school Admin Head can create classes." },
        { status: 403 }
      );
    }
    if (!me.school_id) {
      return NextResponse.json(
        { error: "Set up your school first, then create classes." },
        { status: 400 }
      );
    }

    // 2) Parse + validate body.
    const body = await req.json().catch(() => ({}));
    const grade = normaliseLabel(body.grade);
    const section = normaliseLabel(body.section);

    if (!grade) {
      return NextResponse.json({ error: "Grade label is required." }, { status: 400 });
    }
    if (grade.length > MAX_LABEL_LEN) {
      return NextResponse.json(
        { error: `Grade label is too long (max ${MAX_LABEL_LEN} characters).` },
        { status: 400 }
      );
    }
    if (!isCleanLabel(grade)) {
      return NextResponse.json(
        { error: "Grade can use letters, numbers, spaces, and basic punctuation only." },
        { status: 400 }
      );
    }
    if (!section) {
      return NextResponse.json({ error: "Section label is required." }, { status: 400 });
    }
    if (section.length > MAX_LABEL_LEN) {
      return NextResponse.json(
        { error: `Section label is too long (max ${MAX_LABEL_LEN} characters).` },
        { status: 400 }
      );
    }
    if (!isCleanLabel(section)) {
      return NextResponse.json(
        { error: "Section can use letters, numbers, spaces, and basic punctuation only." },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    // 3) School-wide duplicate guard, case-insensitive.
    const { data: existing } = await admin
      .from("classes")
      .select("id, grade, section")
      .eq("school_id", me.school_id);
    const dup = (existing || []).find((c: { grade: string | null; section: string | null }) => {
      const g = (c.grade || "").trim().toLowerCase();
      const s = (c.section || "").trim().toLowerCase();
      return g === grade.toLowerCase() && s === section.toLowerCase();
    });
    if (dup) {
      return NextResponse.json(
        {
          error: `Your school already has a class for Grade ${grade} \u00b7 Section ${section}. Pick a different grade or section.`,
        },
        { status: 409 }
      );
    }

    // 4) Generate a unique join code.
    let join_code = generateQuizCode();
    for (let i = 0; i < 4; i++) {
      const { data: codeClash } = await admin
        .from("classes")
        .select("id")
        .eq("join_code", join_code)
        .maybeSingle();
      if (!codeClash) break;
      join_code = generateQuizCode();
    }

    // 5) Insert. owner_id is null until a primary teacher is assigned later.
    const name = buildCanonicalName(grade, section);
    const { data: created, error: insErr } = await admin
      .from("classes")
      .insert({
        school_id: me.school_id,
        owner_id: null,
        name,
        grade,
        subject: null,
        section,
        join_code,
      })
      .select("id, name, grade, section, join_code, owner_id, school_id")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, class: created });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create class" },
      { status: 500 }
    );
  }
}
