import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/xray/save-as-paper
 *
 * Body: { xray_id: string }
 *
 * Copies the questions from a past_paper_xrays row into a new exam_papers
 * row + exam_paper_questions rows, preserving the per-question bloom_level,
 * answer, and explanation from the X-Ray. The user becomes the paper's
 * owner and can then edit / print it from the regular exam paper area.
 *
 * Question type defaults to "long_answer" for safety since X-Ray analyses
 * arbitrary papers - the teacher can change it per row in the editor.
 *
 * Auth: caller must own the source X-Ray.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const xrayId: string = String(body.xray_id || "").trim();
    if (!xrayId) return NextResponse.json({ error: "xray_id is required" }, { status: 400 });

    // RLS already restricts past_paper_xrays selects to owner; this select
    // just returns null if the caller isn't allowed.
    const { data: xray, error: xrErr } = await sb
      .from("past_paper_xrays")
      .select("id, paper_title, file_name, total_questions")
      .eq("id", xrayId)
      .maybeSingle();
    if (xrErr) return NextResponse.json({ error: xrErr.message }, { status: 500 });
    if (!xray) return NextResponse.json({ error: "X-Ray not found" }, { status: 404 });

    // Pull the per-question rows. We try with answer/explanation first;
    // fall back to legacy shape if migration 17 hasn't been applied yet.
    let qs: Array<{
      position: number;
      question_text: string;
      bloom_level: string | null;
      answer?: string | null;
      explanation?: string | null;
    }> = [];
    const full = await sb
      .from("past_paper_xray_questions")
      .select("position, question_text, bloom_level, answer, explanation")
      .eq("xray_id", xrayId)
      .order("position", { ascending: true });
    if (full.error && /column.+(answer|explanation).+does not exist/i.test(full.error.message)) {
      const legacy = await sb
        .from("past_paper_xray_questions")
        .select("position, question_text, bloom_level")
        .eq("xray_id", xrayId)
        .order("position", { ascending: true });
      qs = (legacy.data as typeof qs) || [];
    } else if (full.error) {
      return NextResponse.json({ error: full.error.message }, { status: 500 });
    } else {
      qs = (full.data as typeof qs) || [];
    }
    if (qs.length === 0) {
      return NextResponse.json({ error: "This X-Ray has no questions to save" }, { status: 400 });
    }

    const name = `${xray.paper_title || xray.file_name || "Past paper"} (from X-Ray)`.slice(0, 200);

    const { data: paper, error: paperErr } = await sb
      .from("exam_papers")
      .insert({
        owner_id: user.id,
        name,
        status: "draft",
        total_marks: qs.length,
      })
      .select("id")
      .single();
    if (paperErr || !paper) {
      return NextResponse.json({ error: paperErr?.message || "Failed to create paper" }, { status: 500 });
    }

    const ALLOWED_BLOOM = ["remember", "understand", "apply", "analyze", "evaluate", "create"];
    const rows = qs.map((q) => ({
      paper_id: paper.id,
      section_name: "Section A",
      position: q.position,
      question_type: "long_answer" as const,
      stem: q.question_text,
      options: null,
      correct_answer: q.answer ?? null,
      explanation: q.explanation ?? null,
      marks: 1,
      bloom_level: q.bloom_level && ALLOWED_BLOOM.includes(q.bloom_level) ? q.bloom_level : null,
    }));
    const { error: qInsErr } = await sb.from("exam_paper_questions").insert(rows);
    if (qInsErr) {
      // Roll back the paper row so we don't leave an empty paper around.
      await sb.from("exam_papers").delete().eq("id", paper.id);
      return NextResponse.json({ error: qInsErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, paper_id: paper.id, name });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 500 }
    );
  }
}
