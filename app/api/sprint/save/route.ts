import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// =============================================================================
// POST /api/sprint/save
// -----------------------------------------------------------------------------
// Body: { exam_type: 'JEE_MAIN'|'NEET'|'CAT'|'CUSTOM', exam_date: 'YYYY-MM-DD',
//         exam_label?: string, target_air?: number, clear?: boolean }
//
// Upserts the user's exam-sprint settings. If `clear: true` is passed,
// deletes the row instead so the dashboard banner disappears.
//
// We use SELECT → UPDATE/INSERT (not .upsert) per the partial-unique pattern
// established in earlier migrations. exam_sprint_settings doesn't actually
// have a partial unique index — its PK is user_id (not nullable) — but
// keeping the same pattern across all writers means future code reviewers
// don't have to think about it.
// =============================================================================

const VALID_EXAM_TYPES = ["JEE_MAIN", "NEET", "CAT", "CUSTOM"] as const;
type ExamType = (typeof VALID_EXAM_TYPES)[number];

function isExamType(s: string): s is ExamType {
  return (VALID_EXAM_TYPES as readonly string[]).includes(s);
}

// YYYY-MM-DD validator. We don't use Date.parse because it's permissive about
// formats and we want a clean canonical string going into Postgres.
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // Clear path — deletes the sprint settings row.
    if (body.clear === true) {
      await sb.from("exam_sprint_settings").delete().eq("user_id", user.id);
      return NextResponse.json({ ok: true, cleared: true });
    }

    const exam_type_raw = String(body.exam_type || "");
    if (!isExamType(exam_type_raw)) {
      return NextResponse.json({ error: "exam_type must be one of JEE_MAIN, NEET, CAT, CUSTOM" }, { status: 400 });
    }
    const exam_type: ExamType = exam_type_raw;

    const exam_date: string = String(body.exam_date || "");
    if (!isValidIsoDate(exam_date)) {
      return NextResponse.json({ error: "exam_date must be YYYY-MM-DD" }, { status: 400 });
    }

    const exam_label_raw = body.exam_label;
    const exam_label: string | null = typeof exam_label_raw === "string" && exam_label_raw.trim()
      ? exam_label_raw.trim().slice(0, 80)
      : null;

    const target_air_raw = body.target_air;
    const target_air: number | null = Number.isFinite(Number(target_air_raw)) && Number(target_air_raw) > 0
      ? Math.floor(Number(target_air_raw))
      : null;

    // SELECT → UPDATE/INSERT (consistent with subscriptions pattern).
    const { data: existing } = await sb
      .from("exam_sprint_settings")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing) {
      const { error: upErr } = await sb
        .from("exam_sprint_settings")
        .update({
          exam_type,
          exam_label,
          exam_date,
          target_air,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
    } else {
      const { error: insErr } = await sb
        .from("exam_sprint_settings")
        .insert({
          user_id: user.id,
          exam_type,
          exam_label,
          exam_date,
          target_air,
        });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      exam_type,
      exam_label,
      exam_date,
      target_air,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 500 }
    );
  }
}
