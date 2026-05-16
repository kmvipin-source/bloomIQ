import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { isBloomLevel } from "@/lib/bloom";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/qbank/[id]/variants/save
// -----------------------------------------------------------------------------
// Body: { variants: [{ stem, options, correct_index, explanation,
//                      bloom_level, topic }] }
// Persists each as a new question_bank row owned by the calling teacher,
// status='approved'. Returns { ids: string[] }.
// =============================================================================

type IncomingVariant = {
  stem: string;
  options: string[];
  correct_index: number;
  explanation?: string;
  bloom_level: string;
  topic?: string | null;
};

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  try {
    const { id } = await ctx.params;
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // Confirm caller owns the source question.
    // 2026-05-15 (migration 90): also pull the source category so the variant
    // rows inherit it. Variants are paraphrases of the same question — they
    // should live in the same category bucket, never land as Uncategorized.
    const { data: src } = await sb
      .from("question_bank")
      .select("id, owner_id, topic, category")
      .eq("id", id)
      .maybeSingle();
    if (!src) return NextResponse.json({ error: "Source question not found." }, { status: 404 });
    const sourceTopic = (src as { owner_id: string; topic: string | null }).topic;
    const sourceCategory = (src as { category?: string | null }).category ?? null;
    if ((src as { owner_id: string }).owner_id !== user.id) {
      return NextResponse.json({ error: "You don't own this question." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raw = Array.isArray(body?.variants) ? (body.variants as IncomingVariant[]) : [];
    if (raw.length === 0) {
      return NextResponse.json({ error: "No variants supplied." }, { status: 400 });
    }
    if (raw.length > 10) {
      return NextResponse.json({ error: "Too many variants (max 10)." }, { status: 400 });
    }

    type Insert = {
      owner_id: string; topic: string | null; bloom_level: string;
      stem: string; options: string[]; correct_index: number;
      explanation: string | null; status: "approved";
      category: string | null;
    };
    const rows: Insert[] = [];
    for (const v of raw) {
      if (!v || typeof v.stem !== "string" || v.stem.trim().length < 5) continue;
      if (!Array.isArray(v.options) || v.options.length !== 4) continue;
      if (!v.options.every((o) => typeof o === "string")) continue;
      if (!Number.isInteger(v.correct_index) || v.correct_index < 0 || v.correct_index > 3) continue;
      if (!isBloomLevel(v.bloom_level)) continue;
      rows.push({
        owner_id: user.id,
        topic: (typeof v.topic === "string" && v.topic.trim()) ? v.topic.trim() : sourceTopic,
        category: sourceCategory,
        bloom_level: v.bloom_level,
        stem: v.stem.trim(),
        options: v.options.map((o) => String(o).trim()),
        correct_index: v.correct_index,
        explanation: typeof v.explanation === "string" && v.explanation.trim()
          ? v.explanation.trim() : null,
        status: "approved",
      });
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: "All supplied variants were malformed." }, { status: 400 });
    }

    const { data: inserted, error: insErr } = await sb
      .from("question_bank")
      .insert(rows)
      .select("id");
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({
      ids: ((inserted as Array<{ id: string }>) || []).map((r) => r.id),
      saved: rows.length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Save failed" }, { status: 500 });
  }
}
