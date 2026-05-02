"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import {
  ScanSearch, ImageIcon, FileText, ArrowLeft, Loader2, Sparkles, History, ArrowRight,
} from "lucide-react";

// =============================================================================
// PAST-PAPER X-RAY — upload (text or image), AI tags every question by Bloom
// level + topic, returns a heatmap and a "study these 5 things" list.
// =============================================================================

type XrayRow = {
  id: string;
  file_name: string | null;
  paper_title: string | null;
  total_questions: number;
  bloom_breakdown: Record<string, number>;
  topic_breakdown: Record<string, number>;
  created_at: string;
};

export default function XrayPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"text" | "image">("text");
  const [paperText, setPaperText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<XrayRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadHistory();
  }, []);

  async function loadHistory() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb
      .from("past_paper_xrays")
      .select("id, file_name, paper_title, total_questions, bloom_breakdown, topic_breakdown, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setHistory((data as unknown as XrayRow[]) || []);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setErr("Please pick an image file (PNG or JPG). For PDFs, paste the text instead.");
      return;
    }
    if (f.size > 6_000_000) {
      setErr("Image is too large. Try one under 6 MB or paste the text.");
      return;
    }
    setErr(null);
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(String(reader.result || ""));
    reader.readAsDataURL(f);
    toast.success(`Past paper uploaded — ${f.name}`);
  }

  async function analyze() {
    setErr(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");

      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` };
      const r = await fetch("/api/xray/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify(
          mode === "text"
            ? { kind: "text", file_name: fileName, paper_text: paperText.trim() }
            : { kind: "image", file_name: fileName, image_data_url: imageDataUrl }
        ),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "X-Ray failed");
      toast.success("X-Ray analysis complete.");
      router.push(`/student/xray/${j.xray_id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "X-Ray failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    ((mode === "text" && paperText.trim().length >= 50) ||
      (mode === "image" && !!imageDataUrl));

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-sky-100 text-sky-700 p-3 shrink-0">
          <ScanSearch size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Past-Paper X-Ray</h1>
          <p className="muted mt-1">
            Drop in last year&apos;s exam paper. We tag every question by Bloom level and topic, so you can see
            exactly what the examiners love to test — and where to focus your prep.
          </p>
        </div>
      </div>

      <div className="card mt-6">
        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            type="button"
            onClick={() => setMode("text")}
            className={`btn ${mode === "text" ? "btn-primary" : "btn-secondary"}`}
          >
            <FileText size={14} /> Paste text
          </button>
          <button
            type="button"
            onClick={() => setMode("image")}
            className={`btn ${mode === "image" ? "btn-primary" : "btn-secondary"}`}
          >
            <ImageIcon size={14} /> Upload image
          </button>
        </div>

        {mode === "text" ? (
          <>
            <label className="label">Paper text</label>
            <textarea
              className="textarea min-h-[220px]"
              placeholder="Paste the questions from the paper. Numbered or unnumbered both work — we'll figure it out."
              value={paperText}
              onChange={(e) => setPaperText(e.target.value)}
              maxLength={30000}
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs muted">Tip: copy from a PDF viewer. We accept up to 30 000 characters.</p>
              <p className="text-xs muted">{paperText.length} / 30000</p>
            </div>
          </>
        ) : (
          <>
            <label className="label">Paper image</label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onFile}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold hover:file:bg-slate-200"
            />
            {imageDataUrl && (
              <div className="mt-3">
                <img src={imageDataUrl} alt={fileName || "uploaded paper"} className="max-h-64 rounded-lg border border-slate-200 object-contain" />
                <p className="text-xs muted mt-1">{fileName}</p>
              </div>
            )}
            <p className="text-xs muted mt-2">
              For multi-page papers, run one image at a time, or paste the combined text instead.
            </p>
          </>
        )}

        {err && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
        )}

        <button className="btn btn-primary mt-4" onClick={analyze} disabled={!canSubmit}>
          {busy ? <><Loader2 className="animate-spin" size={16} /> Reading the paper…</> : <><Sparkles size={16} /> Run X-Ray</>}
        </button>
      </div>

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Recent X-Rays
      </h2>
      {history.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No X-Rays yet — your first one will appear here.</div>
      ) : (
        <div className="space-y-3">
          {history.map((h) => {
            const heaviestBloom = heaviest(h.bloom_breakdown);
            const heaviestTopic = heaviestKey(h.topic_breakdown);
            return (
              <Link
                key={h.id}
                href={`/student/xray/${h.id}`}
                className="card card-hover flex items-center gap-3 flex-wrap"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900">
                    {h.paper_title || h.file_name || "Past paper"}
                  </div>
                  <div className="text-xs muted mt-1 flex flex-wrap gap-2">
                    <span>{h.total_questions} questions</span>
                    {heaviestBloom && (
                      <span>· heavy on <span className={`badge badge-${heaviestBloom.lvl}`}>{BLOOM_META[heaviestBloom.lvl].label}</span></span>
                    )}
                    {heaviestTopic && <span>· top topic <strong>{heaviestTopic}</strong></span>}
                  </div>
                  <div className="text-[11px] muted mt-1">{new Date(h.created_at).toLocaleDateString()}</div>
                </div>
                <ArrowRight size={16} className="text-slate-400" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function heaviest(obj: Record<string, number>): { lvl: BloomLevel; n: number } | null {
  let best: { lvl: BloomLevel; n: number } | null = null;
  for (const lvl of BLOOM_LEVELS) {
    const n = obj[lvl] || 0;
    if (n > 0 && (!best || n > best.n)) best = { lvl, n };
  }
  return best;
}

function heaviestKey(obj: Record<string, number>): string | null {
  let bestKey: string | null = null;
  let bestN = 0;
  for (const k of Object.keys(obj || {})) {
    const n = obj[k] || 0;
    if (n > bestN) { bestN = n; bestKey = k; }
  }
  return bestKey;
}
