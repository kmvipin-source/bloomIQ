import { NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import { groqText } from "@/lib/groq";

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

    const { data: ans } = await sb.from("attempt_answers").select("is_correct, bloom_level").eq("attempt_id", attemptId);
    const correct = blankBloomCounts(); const totals = blankBloomCounts();
    (ans || []).forEach((x: { bloom_level: BloomLevel; is_correct: boolean | null }) => {
      totals[x.bloom_level] += 1; if (x.is_correct) correct[x.bloom_level] += 1;
    });

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
    const percent = attempt.total ? Math.round((attempt.score / attempt.total) * 100) : 0;
    const badgeColor: [number, number, number] =
      percent >= 75 ? [5, 150, 105] :
      percent >= 50 ? [217, 119, 6] :
      [220, 38, 38];
    doc.setFillColor(...badgeColor);
    doc.roundedRect(M, y, pageW - M * 2, 22, 2, 2, "F");
    doc.setTextColor(255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text(`${attempt.score} / ${attempt.total}`, M + 6, y + 14);
    doc.setFontSize(28);
    doc.text(`${percent}%`, pageW - M - 6, y + 15, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const verdict = percent >= 75 ? "Strong performance" : percent >= 50 ? "On track — room to grow" : "Needs more practice";
    doc.text(verdict, M + 6, y + 19);
    y += 30;

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
