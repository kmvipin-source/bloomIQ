import { NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import { groqText } from "@/lib/groq";
import { resolveScheme, percentageOf, rawScoreLabel } from "@/lib/scoring";
import { SCORING_PRESETS } from "@/lib/scoringPresets";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ attemptId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { attemptId } = await ctx.params;

    const { data: attempt } = await sb
      .from("quiz_attempts")
      .select("*, quiz:quizzes(name, code, owner_id), profile:profiles!quiz_attempts_student_id_fkey(full_name, school, grade)")
      .eq("id", attemptId)
      .maybeSingle();
    if (!attempt) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });

    // Extended fetch (2026-05-12) — we now pull question_id, selected_index,
    // and marks_earned alongside the Bloom aggregation columns so the PDF
    // can also include the per-question review section the student now
    // sees on /student/results/[id].
    const { data: ans } = await sb
      .from("attempt_answers")
      .select("is_correct, bloom_level, question_id, selected_index, marks_earned")
      .eq("attempt_id", attemptId);
    const correct = blankBloomCounts(); const totals = blankBloomCounts();
    (ans || []).forEach((x: { bloom_level: BloomLevel; is_correct: boolean | null }) => {
      totals[x.bloom_level] += 1; if (x.is_correct) correct[x.bloom_level] += 1;
    });

    // Per-question review payload — join attempt_answers to question_bank
    // + quiz_questions for the canonical stem / options / explanation /
    // position. Best-effort: if any of these reads fail we skip the
    // review section silently so the rest of the PDF still renders.
    type ReviewQ = {
      position: number;
      stem: string;
      options: string[];
      correct_index: number;
      selected_index: number | null;
      is_correct: boolean | null;
      explanation: string | null;
      bloom_level: BloomLevel;
      marks_earned: number | null;
    };
    let reviewItems: ReviewQ[] = [];
    try {
      type AnsRow = {
        question_id: string;
        selected_index: number | null;
        marks_earned: number | null;
        is_correct: boolean | null;
        bloom_level: BloomLevel;
      };
      const ansTyped = (ans as AnsRow[] | null) || [];
      const qids = ansTyped.map((a) => a.question_id).filter(Boolean);
      if (qids.length > 0) {
        const quizId = (attempt as { quiz_id?: string }).quiz_id || "";
        const [qBank, qOrder] = await Promise.all([
          sb
            .from("question_bank")
            .select("id, stem, options, correct_index, explanation")
            .in("id", qids),
          quizId
            ? sb
                .from("quiz_questions")
                .select("question_id, position")
                .eq("quiz_id", quizId)
                .in("question_id", qids)
            : Promise.resolve({ data: [] as Array<{ question_id: string; position: number }> }),
        ]);
        type QbRow = { id: string; stem: string; options: string[]; correct_index: number; explanation: string | null };
        type QqRow = { question_id: string; position: number };
        const qbById = new Map<string, QbRow>();
        ((qBank.data as QbRow[]) || []).forEach((r) => qbById.set(r.id, r));
        const positionById = new Map<string, number>();
        ((qOrder.data as QqRow[] | null) || []).forEach((r) => positionById.set(r.question_id, r.position));
        reviewItems = ansTyped
          .map((row) => {
            const q = qbById.get(row.question_id);
            if (!q) return null;
            return {
              position: positionById.get(row.question_id) ?? 0,
              stem: q.stem,
              options: Array.isArray(q.options) ? q.options : [],
              correct_index: q.correct_index,
              selected_index: row.selected_index,
              is_correct: row.is_correct,
              explanation: q.explanation || null,
              bloom_level: row.bloom_level,
              marks_earned: row.marks_earned,
            } as ReviewQ;
          })
          .filter((x): x is ReviewQ => x !== null)
          .sort((a, b) => a.position - b.position);
      }
    } catch { /* silent — PDF renders without the review block */ }

    // AI commentary
    let commentary = "";
    try {
      const lines = BLOOM_LEVELS.filter((l) => totals[l] > 0)
        .map((l) => `- ${BLOOM_META[l].label}: ${correct[l]}/${totals[l]}`).join("\n");
      commentary = await groqText(
        `You are a school report-card writer. Write a single-paragraph teacher comment (3-4 sentences) about a student's Bloom-level performance. Highlight a strength and an area to develop. Encouraging but honest.`,
        `Student: ${attempt.profile?.full_name || "Student"}
Score: ${attempt.score}/${attempt.total}
${lines}`
      );
    } catch { commentary = "Continue practising consistently to build deeper understanding."; }

    // ============================================================
    // PDF layout
    // ============================================================
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const M = 16; // page margin

    // --- Branded header band ---
    doc.setFillColor(5, 150, 105);
    doc.rect(0, 0, pageW, 28, "F");
    doc.setTextColor(255);
    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("BloomIQ", M, 14);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text("Student Report Card", M, 21);
    doc.setFontSize(9);
    doc.text(
      attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleDateString() : "",
      pageW - M,
      14,
      { align: "right" }
    );
    doc.text("bloomiq.app", pageW - M, 21, { align: "right" });

    // --- Student info card ---
    let y = 38;
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(M, y, pageW - M * 2, 32, 2, 2, "FD");

    doc.setTextColor(15, 23, 42);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    const labelCol1X = M + 4;
    const valueCol1X = M + 28;
    const labelCol2X = pageW / 2 + 6;
    const valueCol2X = pageW / 2 + 30;

    const drawRow = (label: string, value: string, lx: number, vx: number, ry: number) => {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 116, 139);
      doc.text(label, lx, ry);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(15, 23, 42);
      doc.text(value || "—", vx, ry, { maxWidth: pageW / 2 - vx + (lx === labelCol1X ? 0 : M) - 4 });
    };

    drawRow("STUDENT", attempt.profile?.full_name || "—", labelCol1X, valueCol1X, y + 7);
    drawRow("SCHOOL", attempt.profile?.school || "—", labelCol1X, valueCol1X, y + 14);
    drawRow("GRADE", attempt.profile?.grade || "—", labelCol1X, valueCol1X, y + 21);
    drawRow("QUIZ", attempt.quiz?.name || "—", labelCol2X, valueCol2X, y + 7);
    drawRow("CODE", attempt.quiz?.code || "—", labelCol2X, valueCol2X, y + 14);
    drawRow(
      "DATE",
      attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleString() : "—",
      labelCol2X,
      valueCol2X,
      y + 21,
    );
    drawRow(
      "TIME TAKEN",
      attempt.time_taken_seconds ? `${Math.round(attempt.time_taken_seconds / 60)} min` : "—",
      labelCol1X,
      valueCol1X,
      y + 28,
    );

    y += 40;

    // --- Score badge ---
    // Marking-scheme aware. Prefers raw_score / max_score (migration 76)
    // when present; falls back to legacy score / total when NULL (every
    // pre-migration attempt). percentageOf() clamps at 0 for safety on
    // negative-raw attempts. Same math the student saw on the result
    // page — single source of truth via lib/scoring.ts.
    const percentExact = percentageOf(attempt);
    const percent = Math.round(percentExact);
    const label = rawScoreLabel(attempt);
    const scoreText = label ? `${formatNumber(label.raw)} / ${formatNumber(label.max)}` : "—";
    const badgeColor: [number, number, number] =
      percent >= 75 ? [5, 150, 105] :
      percent >= 50 ? [217, 119, 6] :
      [220, 38, 38];
    doc.setFillColor(...badgeColor);
    doc.roundedRect(M, y, pageW - M * 2, 22, 2, 2, "F");
    doc.setTextColor(255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text(scoreText, M + 6, y + 14);
    doc.setFontSize(28);
    doc.text(`${percent}%`, pageW - M - 6, y + 15, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const verdict = percent >= 75 ? "Strong performance" : percent >= 50 ? "On track — room to grow" : "Needs more practice";
    doc.text(verdict, M + 6, y + 19);
    y += 30;

    // --- Marking-scheme line (printed only when the attempt was scored
    // under a non-default scheme — keeps practice quizzes uncluttered).
    const schemeForReport = resolveScheme(
      (attempt as { marking_scheme_snapshot?: unknown }).marking_scheme_snapshot
    );
    if (schemeForReport.preset !== "PRACTICE" || schemeForReport.negative_marks_enabled) {
      doc.setTextColor(100, 116, 139);
      doc.setFontSize(9);
      const r = schemeForReport.rules.default;
      const negLabel = schemeForReport.negative_marks_enabled
        ? ` · wrong ${r.wrong > 0 ? "+" : ""}${r.wrong}`
        : "";
      doc.text(
        `Marking: ${SCORING_PRESETS[schemeForReport.preset].label} (correct +${r.correct}${negLabel} · skip ${r.unattempted})`,
        M,
        y,
      );
      y += 6;
    }

    // --- Bloom table heading ---
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Bloom's Taxonomy breakdown", M, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text("Performance broken down by cognitive level.", M, y + 5);
    y += 9;

    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [["Level", "Description", "Correct", "Score"]],
      body: BLOOM_LEVELS.map((l) => [
        BLOOM_META[l].label,
        BLOOM_META[l].description,
        `${correct[l]}/${totals[l]}`,
        totals[l] ? `${Math.round((correct[l] / totals[l]) * 100)}%` : "—",
      ]),
      headStyles: {
        fillColor: [5, 150, 105],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        halign: "left",
      },
      bodyStyles: { fontSize: 10, cellPadding: 3, textColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 28 },
        1: { cellWidth: "auto" },
        2: { halign: "center", cellWidth: 22 },
        3: { halign: "center", fontStyle: "bold", cellWidth: 22 },
      },
      styles: { lineColor: [226, 232, 240], lineWidth: 0.1 },
    });

    // @ts-expect-error jspdf-autotable adds lastAutoTable to the doc
    let after = (doc.lastAutoTable?.finalY || y) + 10;

    // --- Teacher comment block ---
    if (after > pageH - 50) { doc.addPage(); after = M + 10; }
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(255, 251, 235);
    const splitForBox = doc.splitTextToSize(commentary, pageW - M * 2 - 8);
    const boxH = 14 + splitForBox.length * 5;
    doc.roundedRect(M, after, pageW - M * 2, boxH, 2, 2, "FD");
    doc.setTextColor(120, 53, 15);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Teacher comment", M + 4, after + 7);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(30, 41, 59);
    doc.text(splitForBox, M + 4, after + 13);
    after = after + boxH + 10;

    // --- Per-question review (2026-05-12) ---
    // Mirrors the "Review your answers" section on /student/results/[id].
    // For each question: stem, all 4 options (correct + student's pick
    // marked), short explanation. Page-breaks as needed. Renders nothing
    // when reviewItems is empty (e.g., legacy attempts with no question
    // bank rows still attached).
    if (reviewItems.length > 0) {
      if (after > pageH - 40) { doc.addPage(); after = M + 10; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(15, 23, 42);
      doc.text("Review your answers", M, after);
      after += 7;

      const lineW = pageW - M * 2;
      for (let i = 0; i < reviewItems.length; i++) {
        const q = reviewItems[i];
        const isSkipped = q.selected_index === null;
        const isRight = !isSkipped && q.is_correct === true;
        const verdict = isRight ? "Correct" : isSkipped ? "Skipped" : "Wrong";
        const verdictColor: [number, number, number] = isRight
          ? [5, 150, 105]
          : isSkipped
          ? [180, 83, 9]
          : [185, 28, 28];

        const stemLines = doc.splitTextToSize(`Q${i + 1}. ${q.stem}`, lineW - 4);
        // Pre-estimate height: stem + 4 options + (optional) explanation lines.
        const optionLines: string[][] = q.options.map((opt, oi) => {
          const prefix = `${String.fromCharCode(65 + oi)}. `;
          const marker = oi === q.correct_index ? "  ✓"
                        : oi === q.selected_index ? "  ←"
                        : "";
          return doc.splitTextToSize(`${prefix}${opt}${marker}`, lineW - 8);
        });
        const explLines = q.explanation
          ? doc.splitTextToSize(`Explanation: ${q.explanation}`, lineW - 8)
          : [];
        const estH = 8 + stemLines.length * 5 + optionLines.reduce((s, ls) => s + ls.length * 5, 0) + (explLines.length ? 4 + explLines.length * 4 : 0) + 4;
        if (after + estH > pageH - 20) { doc.addPage(); after = M + 10; }

        // Verdict pill
        doc.setFillColor(...verdictColor);
        doc.setTextColor(255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        const pillW = 14;
        doc.roundedRect(M, after - 4, pillW, 5, 1, 1, "F");
        doc.text(verdict, M + pillW / 2, after - 0.6, { align: "center" });

        // Stem
        doc.setTextColor(15, 23, 42);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(stemLines, M + pillW + 3, after);
        after += stemLines.length * 5 + 1;

        // Options
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        for (let oi = 0; oi < q.options.length; oi++) {
          if (oi === q.correct_index) doc.setTextColor(5, 150, 105);
          else if (oi === q.selected_index) doc.setTextColor(185, 28, 28);
          else doc.setTextColor(71, 85, 105);
          doc.text(optionLines[oi], M + 4, after);
          after += optionLines[oi].length * 5;
        }

        // Explanation (if present)
        if (explLines.length > 0) {
          after += 1;
          doc.setTextColor(100, 116, 139);
          doc.setFont("helvetica", "italic");
          doc.setFontSize(8);
          doc.text(explLines, M + 4, after);
          after += explLines.length * 4;
        }

        after += 5;
      }
    }

    // --- Footer (every page) ---
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.setDrawColor(226, 232, 240);
      doc.line(M, pageH - 14, pageW - M, pageH - 14);
      doc.setTextColor(100, 116, 139);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.text("Generated by BloomIQ — bloom-aligned assessments", M, pageH - 8);
      doc.text(`Page ${i} of ${total}`, pageW - M, pageH - 8, { align: "right" });
    }

    function formatNumber(n: number): string {
      // Print integers cleanly (no trailing .0), decimals to two places.
      // Negative raw scores (rare, e.g. JEE Main mock with many wrong)
      // print with their minus sign — transparency matches CAT/JEE.
      if (Number.isInteger(n)) return String(n);
      return n.toFixed(2);
    }

    const bytes = doc.output("arraybuffer");
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="bloomiq-report-${attemptId.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
