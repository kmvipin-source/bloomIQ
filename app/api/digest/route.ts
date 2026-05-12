import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import { pct } from "@/lib/utils";

export const runtime = "nodejs";

/**
 * Builds a weekly digest for a teacher's quiz and either sends via SMTP
 * (if EMAIL/PASS env vars are set) or returns a preview body.
 *
 * To enable real sending, set in .env.local:
 *   EMAIL=your@gmail.com
 *   PASS=your_gmail_app_password
 *   DIGEST_FROM=BloomIQ <your@gmail.com>
 */

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { quizId } = await req.json();
    // Restrict to the caller's own quiz. Without the owner_id filter
    // an authenticated user could request a digest of any quiz they
    // could read through RLS — and any RLS gap would leak attempt
    // rows belonging to another teacher's students.
    const { data: quiz } = await sb
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

    const { data: atts } = await sb
      .from("quiz_attempts")
      .select("id, score, total, submitted_at, profile:profiles!quiz_attempts_student_id_fkey(full_name)")
      .eq("quiz_id", quizId)
      .not("submitted_at", "is", null);

    const totals = blankBloomCounts(); const correct = blankBloomCounts();
    for (const a of (atts as Array<{ id: string; score: number; total: number }>) || []) {
      const { data: ans } = await sb.from("attempt_answers").select("is_correct, bloom_level").eq("attempt_id", a.id);
      (ans || []).forEach((x: { bloom_level: BloomLevel; is_correct: boolean | null }) => {
        totals[x.bloom_level] += 1; if (x.is_correct) correct[x.bloom_level] += 1;
      });
    }

    const completed = ((atts || []) as unknown) as Array<{ score: number; total: number; profile: { full_name: string | null } | null }>;
    const classAvg = completed.length ? Math.round(completed.reduce((s, a) => s + pct(a.score, a.total), 0) / completed.length) : 0;
    const atRisk = completed.filter((a) => pct(a.score, a.total) < 50).map((a) => a.profile?.full_name || "Unknown");

    const html = `
      <div style="font-family: -apple-system, sans-serif; max-width: 600px;">
        <h2 style="color: #047857;">🌱 BloomIQ — Weekly Digest</h2>
        <p><strong>${quiz.name}</strong> · code <code>${quiz.code}</code></p>
        <p>Class average: <strong>${classAvg}%</strong> across ${completed.length} students</p>
        <h3>Bloom-level breakdown</h3>
        <table cellpadding="6" style="border-collapse: collapse; width: 100%;">
          <tr style="background:#f1f5f9;"><th align="left">Level</th><th align="right">Score</th></tr>
          ${BLOOM_LEVELS.map((l) => `
            <tr><td>${BLOOM_META[l].label}</td>
                <td align="right">${totals[l] ? Math.round((correct[l] / totals[l]) * 100) + "%" : "—"}</td></tr>
          `).join("")}
        </table>
        <h3>At-risk students</h3>
        <p>${atRisk.length ? atRisk.join(", ") : "None — nice work!"}</p>
        <hr/>
        <p style="color:#64748b;font-size:12px;">Sent by BloomIQ</p>
      </div>`;

    const subject = `BloomIQ digest — ${quiz.name}`;

    const { EMAIL, PASS, DIGEST_FROM } = process.env;
    if (!EMAIL || !PASS) {
      return NextResponse.json({
        ok: true,
        message: "Email not configured. Set EMAIL and PASS in .env.local to send. Preview generated below.",
        preview: { subject, html },
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL, pass: PASS },
    });
    const { data: prof } = await sb.from("profiles").select("full_name").eq("id", user.id).single();
    void prof;
    const to = (await sb.auth.getUser()).data.user?.email;
    if (!to) return NextResponse.json({ error: "No email on account" }, { status: 400 });
    await transporter.sendMail({ from: DIGEST_FROM || EMAIL, to, subject, html });
    return NextResponse.json({ ok: true, message: `Digest sent to ${to}.` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
