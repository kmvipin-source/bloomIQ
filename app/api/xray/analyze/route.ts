import { NextResponse } from "next/server";
import { groqJSON, groqJSONVision } from "@/lib/groq";
import { BLOOM_LEVELS, isBloomLevel, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 90;

const SYSTEM = `You are an examiner who tags every question on a past exam paper by Bloom's taxonomy and topic, AND provides a worked answer + explanation for each question so the student can study from it.

You will be given the paper as text or an image. Find each question (numbered or not). For each question produce:
- "position": 1-based index
- "question_text": the verbatim question (preserve numbering, sub-parts, units)
- "bloom_level": one of "remember", "understand", "apply", "analyze", "evaluate", "create"
- "topic": a short topic label (2-4 words; reuse labels across similar questions)
- "answer": the correct answer.
    - For MCQ / multiple-choice: state the letter AND the full text of the correct option ("B. The Krebs cycle").
    - For numerical: give the final number with units ("9.8 m/s^2").
    - For short/long answer: a complete, exam-quality answer in 1-4 sentences.
    - If the input paper contained an explicit answer key for this question, use that answer; only generate from your knowledge when the input does NOT include an answer.
- "explanation": a 1-3 sentence reasoning trail that shows WHY the answer is correct. For numericals, show the key formula or step. The goal is teaching, not just stating.

Then produce overall fields:
- "paper_title": a short label for the paper if you can infer one ("CBSE Bio 2023" or null)
- "recommendations": EXACTLY 5 short, concrete study actions targeted at the heaviest Bloom level + topic combinations. Each is one sentence, written as a directive ("Drill applying Newton's third law to two-block pulley problems").

Respond with VALID JSON only:
{
  "paper_title": "..." | null,
  "questions": [
    { "position": 1, "question_text": "...", "bloom_level": "...", "topic": "...", "answer": "...", "explanation": "..." }
  ],
  "recommendations": ["...", "...", "...", "...", "..."]
}

If the paper text is junk or contains no recognizable questions, return an empty questions array and an empty recommendations array. If a question's correct answer is genuinely ambiguous or context-dependent, set answer to a representative model answer and explanation to a brief rationale.`;

type Q = {
  position: number;
  question_text: string;
  bloom_level: BloomLevel | null;
  topic: string | null;
  answer: string | null;
  explanation: string | null;
};

function clean(arr: unknown): Q[] {
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[])
    .map((it) => {
      const o = (it || {}) as Record<string, unknown>;
      const position = Number(o.position);
      const question_text = String(o.question_text || "").trim();
      const blRaw = String(o.bloom_level || "").toLowerCase().trim();
      const bloom_level: BloomLevel | null = isBloomLevel(blRaw) ? blRaw : null;
      const topic = String(o.topic || "").trim() || null;
      const answer = String(o.answer || "").trim().slice(0, 2000) || null;
      const explanation = String(o.explanation || "").trim().slice(0, 2000) || null;
      if (!Number.isFinite(position) || !question_text) return null;
      return { position, question_text, bloom_level, topic, answer, explanation };
    })
    .filter((q): q is Q => q !== null)
    .slice(0, 100);
}

function bloomCounts(qs: Q[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const lvl of BLOOM_LEVELS) out[lvl] = 0;
  for (const q of qs) if (q.bloom_level) out[q.bloom_level] += 1;
  return out;
}

function topicCounts(qs: Q[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of qs) {
    if (!q.topic) continue;
    out[q.topic] = (out[q.topic] || 0) + 1;
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const kind: string = String(body.kind || "");
    const file_name: string | null = body.file_name ? String(body.file_name).slice(0, 200) : null;

    let raw: Record<string, unknown> = {};
    if (kind === "text") {
      const paper_text = String(body.paper_text || "").trim();
      if (paper_text.length < 50) {
        return NextResponse.json({ error: "Paste at least a paragraph of the paper text." }, { status: 400 });
      }
      if (paper_text.length > 30000) {
        return NextResponse.json({ error: "Paper text is too long (max 30k chars)." }, { status: 400 });
      }
      raw = await groqJSON(SYSTEM, `Paper text:\n"""\n${paper_text}\n"""\n\nReturn the JSON now.`);
    } else if (kind === "image") {
      const image_data_url = String(body.image_data_url || "");
      if (!image_data_url.startsWith("data:image/")) {
        return NextResponse.json({ error: "Provide a base64 image data URL (data:image/png;base64,...)." }, { status: 400 });
      }
      if (image_data_url.length > 8_000_000) {
        return NextResponse.json({ error: "Image too large (max ~6 MB)." }, { status: 400 });
      }
      raw = await groqJSONVision(SYSTEM, "Here is the past paper as an image. Tag every question and provide the answer + explanation.", image_data_url);
    } else {
      return NextResponse.json({ error: "kind must be 'text' or 'image'" }, { status: 400 });
    }

    const qs = clean(raw.questions);
    if (qs.length === 0) {
      return NextResponse.json(
        { error: "We couldn't find any questions in that paper. Try pasting the text directly, or use a clearer image." },
        { status: 422 }
      );
    }

    const paper_title: string | null = typeof raw.paper_title === "string" && raw.paper_title.trim()
      ? raw.paper_title.trim().slice(0, 120)
      : null;

    const recsRaw = raw.recommendations;
    const recommendations: string[] = Array.isArray(recsRaw)
      ? (recsRaw as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8)
      : [];

    // Persist the summary row.
    const { data: xray, error: xrErr } = await sb
      .from("past_paper_xrays")
      .insert({
        user_id: user.id,
        file_name,
        paper_title,
        total_questions: qs.length,
        bloom_breakdown: bloomCounts(qs),
        topic_breakdown: topicCounts(qs),
        recommendations,
      })
      .select("id")
      .single();
    if (xrErr || !xray) return NextResponse.json({ error: xrErr?.message || "Failed to save xray" }, { status: 500 });

    // Persist per-question rows. answer + explanation come from migration 17.
    // If that migration hasn't been applied to the deployed DB yet, retry
    // with the legacy shape so the X-Ray itself still saves and the user
    // gets a clear hint via the response field below.
    const qRows = qs.map((q) => ({
      xray_id: xray.id,
      position: q.position,
      question_text: q.question_text,
      bloom_level: q.bloom_level,
      topic: q.topic,
      answer: q.answer,
      explanation: q.explanation,
    }));
    let answersStored = true;
    const { error: qInsErr } = await sb.from("past_paper_xray_questions").insert(qRows);
    if (qInsErr) {
      if (/column.+(answer|explanation).+does not exist/i.test(qInsErr.message)) {
        const legacyRows = qs.map((q) => ({
          xray_id: xray.id,
          position: q.position,
          question_text: q.question_text,
          bloom_level: q.bloom_level,
          topic: q.topic,
        }));
        const { error: legacyErr } = await sb.from("past_paper_xray_questions").insert(legacyRows);
        if (legacyErr) return NextResponse.json({ error: legacyErr.message }, { status: 500 });
        answersStored = false;
      } else {
        return NextResponse.json({ error: qInsErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true,
      xray_id: xray.id,
      total_questions: qs.length,
      paper_title,
      bloom_breakdown: bloomCounts(qs),
      topic_breakdown: topicCounts(qs),
      recommendations,
      answersStored,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "X-Ray failed" },
      { status: 500 }
    );
  }
}
