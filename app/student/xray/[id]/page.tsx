"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, isBloomLevel, type BloomLevel } from "@/lib/bloom";
import { ArrowLeft, ScanSearch, Lightbulb, Printer, FileDown, Loader2 } from "lucide-react";

// =============================================================================
// PAST-PAPER X-RAY DETAIL - heatmap + per-question list (with AI-generated
// answer + explanation) + study recs + Print / Save-as-paper actions.
// =============================================================================

type XrayRow = {
  id: string;
  paper_title: string | null;
  file_name: string | null;
  total_questions: number;
  bloom_breakdown: Record<string, number>;
  topic_breakdown: Record<string, number>;
  recommendations: string[];
  created_at: string;
};

type QRow = {
  id: string;
  position: number;
  question_text: string;
  bloom_level: string | null;
  topic: string | null;
  answer: string | null;
  explanation: string | null;
};

export default function XrayDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<XrayRow | null>(null);
  const [qs, setQs] = useState<QRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [savingPaper, setSavingPaper] = useState(false);
  const [savedPaperId, setSavedPaperId] = useState<string | null>(null);
  const [savedPaperName, setSavedPaperName] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // The user's role gates the link target for "Save as paper". Teachers can
  // open the saved paper at /teacher/papers/[id] which exists. Students don't
  // have a parallel UI yet, so we show a clearer message and link them back
  // to their X-Ray history (which IS their saved papers list).
  const [userRole, setUserRole] = useState<"teacher" | "student" | "super_teacher" | null>(null);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
        const role = (prof as { role?: string } | null)?.role;
        if (role === "teacher" || role === "student" || role === "super_teacher") {
          setUserRole(role);
        }
      }
      const { data: r } = await sb
        .from("past_paper_xrays")
        .select("*")
        .eq("id", id)
        .single();
      setRow(r as XrayRow);
      // Try to fetch with answer+explanation; if migration 17 isn't applied
      // yet, fall back to the legacy column set so the page still loads.
      let qd: QRow[] | null = null;
      const full = await sb
        .from("past_paper_xray_questions")
        .select("id, position, question_text, bloom_level, topic, answer, explanation")
        .eq("xray_id", id)
        .order("position", { ascending: true });
      if (full.error && /column.+(answer|explanation).+does not exist/i.test(full.error.message)) {
        const legacy = await sb
          .from("past_paper_xray_questions")
          .select("id, position, question_text, bloom_level, topic")
          .eq("xray_id", id)
          .order("position", { ascending: true });
        qd = ((legacy.data || []) as Array<Omit<QRow, "answer" | "explanation">>).map((q) => ({
          ...q, answer: null, explanation: null,
        }));
      } else {
        qd = (full.data as unknown as QRow[]) || null;
      }
      setQs(qd || []);
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  if (!row) return <div className="max-w-2xl mx-auto py-12 text-center muted">X-Ray not found.</div>;

  const total = row.total_questions || 1;
  const bloomMax = Math.max(1, ...Object.values(row.bloom_breakdown || {}));
  const topics = Object.entries(row.topic_breakdown || {}).sort((a, b) => b[1] - a[1]);
  const hasAnyAnswer = qs.some((q) => q.answer || q.explanation);

  function isRevealed(qid: string): boolean {
    return !!(revealAll || revealed[qid]);
  }

  function toggleOne(qid: string) {
    setRevealed((m) => ({ ...m, [qid]: !m[qid] }));
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
      c === "&" ? "&amp;" :
      c === "<" ? "&lt;" :
      c === ">" ? "&gt;" :
      c === '"' ? "&quot;" : "&#39;"
    ));
  }

  // Print-friendly view: opens a new window with a clean question paper
  // layout - title, per-question stem with Bloom badge, answer, explanation.
  // Uses window.print() so the user can also "Save as PDF" from the dialog.
  function printPaper() {
    const w = window.open("", "_blank", "noopener,noreferrer,width=820,height=900");
    if (!w) {
      alert("Pop-up blocked. Allow pop-ups to print.");
      return;
    }
    const heading = row?.paper_title || row?.file_name || "Past paper";
    const generatedOn = new Date(row?.created_at || Date.now()).toLocaleDateString();
    const items = qs.map((q) => {
      const lvl = q.bloom_level && isBloomLevel(q.bloom_level) ? q.bloom_level : null;
      const bloomLabel = lvl ? BLOOM_META[lvl].label : "";
      const bloomColor = lvl ? BLOOM_META[lvl].color : "#94a3b8";
      const ans = q.answer ? `<div class="ans"><span class="lbl">Answer</span><div class="body">${escapeHtml(q.answer)}</div></div>` : "";
      const exp = q.explanation ? `<div class="exp"><span class="lbl">Why</span><div class="body">${escapeHtml(q.explanation)}</div></div>` : "";
      return `
        <div class="q">
          <div class="qhead">
            <div class="num">Q${q.position}</div>
            <div class="meta">
              ${lvl ? `<span class="badge" style="background:${bloomColor}1a;color:${bloomColor};border-color:${bloomColor}66">${escapeHtml(bloomLabel)}</span>` : ""}
              ${q.topic ? `<span class="topic">${escapeHtml(q.topic)}</span>` : ""}
            </div>
          </div>
          <div class="stem">${escapeHtml(q.question_text)}</div>
          ${ans}
          ${exp}
        </div>
      `;
    }).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(heading)} - BloomIQ X-Ray</title><style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 1.2rem; color: #0f172a; max-width: 880px; margin: 0 auto; line-height: 1.5; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .sub { color: #64748b; font-size: 12px; margin-bottom: 18px; }
      .q { padding: 14px 0; border-bottom: 1px solid #e2e8f0; page-break-inside: avoid; }
      .qhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      .num { font-weight: 700; color: #475569; font-size: 12px; letter-spacing: .04em; }
      .meta { display: flex; gap: 6px; flex-wrap: wrap; }
      .badge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; padding: 2px 8px; border-radius: 999px; border: 1px solid; }
      .topic { font-size: 11px; color: #475569; background: #f1f5f9; padding: 2px 8px; border-radius: 999px; }
      .stem { font-size: 14px; margin-bottom: 8px; }
      .ans, .exp { margin-top: 6px; padding: 8px 10px; border-radius: 6px; font-size: 13px; }
      .ans { background: #ecfdf5; border-left: 3px solid #10b981; }
      .exp { background: #eff6ff; border-left: 3px solid #6366f1; }
      .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; color: #475569; display: block; margin-bottom: 2px; }
      .body { white-space: pre-wrap; }
      @media print { @page { margin: 14mm; } body { padding: 0; } }
    </style></head><body>
      <h1>${escapeHtml(heading)}</h1>
      <div class="sub">${qs.length} question${qs.length === 1 ? "" : "s"} - generated ${escapeHtml(generatedOn)} - BloomIQ X-Ray</div>
      ${items}
      <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 80); }<\/script>
    </body></html>`);
    w.document.close();
  }

  // Save the analyzed X-Ray as a reusable exam paper that the teacher area
  // can edit + print. Calls a tiny server endpoint that copies questions
  // (with bloom_level) into exam_papers + exam_paper_questions.
  async function saveAsPaper() {
    if (savingPaper) return;
    setSaveErr(null);
    setSavingPaper(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired - sign in again.");
      const r = await fetch("/api/xray/save-as-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ xray_id: id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setSavedPaperId(j.paper_id || null);
      setSavedPaperName(j.name || null);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingPaper(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student/xray" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> All X-Rays
      </Link>

      <div className="flex items-start gap-3 flex-wrap">
        <div className="rounded-xl bg-sky-100 text-sky-700 p-3 shrink-0">
          <ScanSearch size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="h1">{row.paper_title || row.file_name || "Past paper"}</h1>
          <p className="muted mt-1">
            {row.total_questions} questions tagged · {new Date(row.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-secondary" onClick={printPaper} title="Open a printable version">
            <Printer size={14} /> Print
          </button>
          <button className="btn btn-secondary" onClick={saveAsPaper} disabled={savingPaper} title="Save as a reusable question paper">
            {savingPaper ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><FileDown size={14} /> Save as paper</>}
          </button>
        </div>
      </div>

      {savedPaperId && (
        <div className="mt-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 px-5 py-4">
          <div className="flex items-center gap-2 text-emerald-900 font-bold mb-2">
            <FileDown size={18} />
            Saved as a question paper
          </div>
          <div className="text-sm text-emerald-900/85 mb-3">
            {savedPaperName ? <strong>{savedPaperName}</strong> : "Your paper"} is now stored with each question&rsquo;s Bloom level. {userRole === "teacher" || userRole === "super_teacher"
              ? "Open it to edit, add marks, or print."
              : "Find all your X-Rayed papers anytime in your X-Ray history."}
          </div>
          <div className="flex flex-wrap gap-2">
            {(userRole === "teacher" || userRole === "super_teacher") ? (
              <>
                <Link href={`/teacher/papers/${savedPaperId}`} className="btn btn-primary">
                  Open this paper →
                </Link>
                <Link href="/teacher/papers" className="btn btn-secondary">
                  All saved papers
                </Link>
              </>
            ) : (
              <Link href="/student/xray" className="btn btn-primary">
                See all my X-Rayed papers →
              </Link>
            )}
          </div>
        </div>
      )}
      {saveErr && (
        <div className="mt-3 text-sm bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg">{saveErr}</div>
      )}

      {/* Bloom heatmap */}
      <div className="card mt-6">
        <h2 className="font-semibold mb-3">Bloom-level mix</h2>
        <div className="space-y-2">
          {BLOOM_LEVELS.map((lvl) => {
            const n = (row.bloom_breakdown || {})[lvl] || 0;
            const pct = Math.round((n / total) * 100);
            const widthFromMax = Math.round((n / bloomMax) * 100);
            return (
              <div key={lvl}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium">{BLOOM_META[lvl].label}</span>
                  <span className="muted">{n} ({pct}%)</span>
                </div>
                <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full transition-all"
                    style={{ width: `${widthFromMax}%`, backgroundColor: BLOOM_META[lvl].color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Topic mix */}
      {topics.length > 0 && (
        <div className="card mt-4">
          <h2 className="font-semibold mb-3">Topic mix</h2>
          <div className="flex flex-wrap gap-2">
            {topics.map(([t, n]) => (
              <span key={t} className="badge bg-slate-100 text-slate-700">
                {t} <span className="ml-1 text-slate-500">×{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {row.recommendations && row.recommendations.length > 0 && (
        <div className="card mt-4 bg-emerald-50/40 border-emerald-200">
          <h2 className="font-semibold mb-3 inline-flex items-center gap-2"><Lightbulb size={18} className="text-emerald-700" /> Study these {row.recommendations.length} things</h2>
          <ul className="space-y-2 text-sm">
            {row.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-600 text-white text-xs font-bold shrink-0">{i + 1}</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-question list with answer/explanation reveal */}
      <div className="flex items-center justify-between mt-8 mb-3 gap-3 flex-wrap">
        <h2 className="h2">Every question, tagged</h2>
        {hasAnyAnswer && (
          <button
            className="btn btn-ghost text-sm"
            onClick={() => setRevealAll((v) => !v)}
            title="Toggle all answers"
          >
            {revealAll ? "Hide all answers" : "Show all answers"}
          </button>
        )}
      </div>
      {!hasAnyAnswer && (
        <div className="card mb-3 text-xs muted bg-amber-50 border-amber-200">
          Answers and explanations aren&rsquo;t stored on this X-Ray yet. Newer X-Rays include them automatically. To enable answers on existing X-Rays, run migration 17 on your Supabase database, or re-run the X-Ray on the same paper.
        </div>
      )}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase muted">
            <tr>
              <th className="px-4 py-3 text-left w-12">#</th>
              <th className="px-4 py-3 text-left">Question</th>
              <th className="px-4 py-3 text-left">Bloom</th>
              <th className="px-4 py-3 text-left">Topic</th>
              <th className="px-4 py-3 text-right">Answer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {qs.map((q) => {
              const lvl: BloomLevel | null = q.bloom_level && isBloomLevel(q.bloom_level) ? q.bloom_level : null;
              const hasAnswer = !!(q.answer || q.explanation);
              const open = isRevealed(q.id);
              return (
                <>
                  <tr key={q.id} className="align-top">
                    <td className="px-4 py-3 muted">{q.position}</td>
                    <td className="px-4 py-3">{q.question_text}</td>
                    <td className="px-4 py-3">
                      {lvl ? <span className={`badge badge-${lvl}`}>{BLOOM_META[lvl].label}</span> : <span className="muted text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {q.topic || <span className="muted text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {hasAnswer ? (
                        <button className="btn btn-ghost text-xs" onClick={() => toggleOne(q.id)}>
                          {open ? "Hide" : "Show"}
                        </button>
                      ) : (
                        <span className="text-xs muted">—</span>
                      )}
                    </td>
                  </tr>
                  {hasAnswer && open && (
                    <tr key={`${q.id}-rev`}>
                      <td className="px-4 pb-3" />
                      <td className="px-4 pb-3" colSpan={4}>
                        {q.answer && (
                          <div className="rounded-md bg-emerald-50 border-l-4 border-emerald-500 px-3 py-2 mb-2">
                            <div className="text-[10px] uppercase tracking-wide font-bold text-emerald-800 mb-0.5">Answer</div>
                            <div className="text-sm whitespace-pre-wrap">{q.answer}</div>
                          </div>
                        )}
                        {q.explanation && (
                          <div className="rounded-md bg-indigo-50 border-l-4 border-indigo-500 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wide font-bold text-indigo-800 mb-0.5">Why</div>
                            <div className="text-sm whitespace-pre-wrap">{q.explanation}</div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
