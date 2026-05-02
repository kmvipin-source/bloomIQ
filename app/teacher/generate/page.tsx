"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { Sparkles, FileText, Image as ImageIcon, GraduationCap, Tag } from "lucide-react";

type Source = "notes" | "image" | "topic_syllabus" | "topic_only";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB raw upload cap
const IMAGE_MAX_DIM = 1600;
const IMAGE_QUALITY = 0.85;

// Downscale an uploaded image client-side to keep the payload small and the
// vision-model call snappy. Returns a JPEG data URL.
async function downscaleToDataUrl(file: File): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = document.createElement("img");
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported in this browser");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
}

export default function GeneratePage() {
  const router = useRouter();

  const [source, setSource] = useState<Source>("notes");
  const [topic, setTopic] = useState("");
  const [content, setContent] = useState("");
  const [className, setClassName] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const [mode, setMode] = useState<"all" | "custom">("all");
  const [pickedLevels, setPickedLevels] = useState<BloomLevel[]>(["understand"]);
  const [numericalPercent, setNumericalPercent] = useState(0);
  const MAX_PICKED = 5;

  function togglePickedLevel(l: BloomLevel) {
    setPickedLevels((prev) => {
      if (prev.includes(l)) return prev.filter((x) => x !== l);
      if (prev.length >= MAX_PICKED) return prev; // cap at 5
      // Preserve canonical Bloom order so the request payload stays predictable
      return BLOOM_LEVELS.filter((b) => prev.includes(b) || b === l);
    });
  }
  const [perLevel, setPerLevel] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<BloomLevel, number> | null>(null);

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setImageFile(null);
    setImagePreview(null);
    if (!f) return;
    if (f.size > MAX_IMAGE_BYTES) {
      setErr(`Image is too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Please pick something under 6 MB.`);
      toast.error("Image > 6 MB.");
      return;
    }
    setErr(null);
    setImageFile(f);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(f);
    toast.success(`Image uploaded — ${f.name}`);
  }

  async function generate() {
    setErr(null);
    setSummary(null);

    // Per-source validation
    if (source === "notes" && content.trim().length < 50) {
      setErr("Please paste at least a paragraph or two of content (50+ characters).");
      return;
    }
    if (source === "image" && !imageFile) {
      setErr("Please choose an image to generate from.");
      return;
    }
    if (source === "topic_syllabus" && (!topic.trim() || !className.trim())) {
      setErr("Please enter a topic and a class/grade. Syllabus is optional but helps.");
      return;
    }
    if (source === "topic_only" && !topic.trim()) {
      setErr("Please enter a topic.");
      return;
    }
    if (mode === "custom" && (pickedLevels.length < 1 || pickedLevels.length > MAX_PICKED)) {
      setErr(`Please choose between 1 and ${MAX_PICKED} Bloom levels.`);
      return;
    }

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");

      const body: Record<string, unknown> = {
        source,
        topic,
        levels: mode === "all" ? BLOOM_LEVELS : pickedLevels,
        perLevel,
        numericalPercent,
      };
      if (source === "notes") body.content = content;
      if (source === "image" && imageFile) {
        body.imageDataUrl = await downscaleToDataUrl(imageFile);
      }
      if (source === "topic_syllabus") {
        body.className = className;
        body.syllabus = syllabus;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setSummary(data.summary);
      toast.success("Questions generated successfully.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: Source; icon: React.ReactNode; label: string; desc: string }> = [
    { id: "notes",           icon: <FileText size={18} />,        label: "From notes",                desc: "Paste a chapter or lesson plan" },
    { id: "image",           icon: <ImageIcon size={18} />,       label: "From an image",             desc: "Photo of a page or diagram" },
    { id: "topic_syllabus",  icon: <GraduationCap size={18} />,   label: "Topic + class + syllabus",  desc: "Aligned to a board / curriculum" },
    { id: "topic_only",      icon: <Tag size={18} />,             label: "Just a topic",              desc: "Quick generation by subject" },
  ];

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <h1 className="h1">Generate questions</h1>
      <p className="muted mt-1">
        Choose a source. AI writes multiple-choice questions tagged by Bloom level — you&apos;ll review them next.
      </p>

      {/* Source picker */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
        {tabs.map((t) => {
          const on = source === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => { setSource(t.id); setErr(null); setSummary(null); }}
              className={`text-left p-4 rounded-xl border transition ${
                on
                  ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2 font-semibold mb-1">{t.icon} {t.label}</div>
              <div className="text-xs muted">{t.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="card mt-4 space-y-5">
        {/* Source-specific inputs */}
        {source === "notes" && (
          <>
            <div>
              <label className="label">Topic (optional)</label>
              <input className="input" placeholder="e.g. Photosynthesis"
                     value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div>
              <label className="label">Paste your notes / content</label>
              <textarea className="textarea" rows={10}
                        placeholder="Paste a chapter, lesson plan, or notes here..."
                        value={content} onChange={(e) => setContent(e.target.value)} />
              <p className="text-xs muted mt-1">{content.length} characters</p>
            </div>
          </>
        )}

        {source === "image" && (
          <>
            <div>
              <label className="label">Topic (optional)</label>
              <input className="input" placeholder="Helps anchor the questions"
                     value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div>
              <label className="label">Upload an image</label>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onPickImage}
                className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-emerald-600 file:text-white hover:file:bg-emerald-700 cursor-pointer"
              />
              <p className="text-xs muted mt-1">
                Photo of a textbook page, worksheet, diagram, or whiteboard works best. PNG / JPEG / WebP, under 6 MB. We&apos;ll resize it before sending.
              </p>
              {imagePreview && (
                <div className="mt-3 rounded-lg overflow-hidden border border-slate-200 max-w-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imagePreview} alt="preview" className="block w-full" />
                </div>
              )}
            </div>
          </>
        )}

        {source === "topic_syllabus" && (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Topic</label>
                <input className="input" placeholder="e.g. Newton's Laws of Motion"
                       value={topic} onChange={(e) => setTopic(e.target.value)} />
              </div>
              <div>
                <label className="label">Class / grade</label>
                <input className="input" placeholder="e.g. Class 9 / Grade 9"
                       value={className} onChange={(e) => setClassName(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Syllabus / board <span className="muted text-xs">(optional)</span></label>
              <input className="input" placeholder="e.g. CBSE, ICSE, Cambridge IGCSE, NCERT Chapter 9"
                     value={syllabus} onChange={(e) => setSyllabus(e.target.value)} />
              <p className="text-xs muted mt-1">If provided, questions are aligned to this curriculum and class level.</p>
            </div>
          </>
        )}

        {source === "topic_only" && (
          <div>
            <label className="label">Topic</label>
            <input className="input" placeholder="e.g. Mitochondria"
                   value={topic} onChange={(e) => setTopic(e.target.value)} />
            <p className="text-xs muted mt-1">No notes or syllabus — questions are written from general knowledge of the topic.</p>
          </div>
        )}

        <div>
          <label className="label">Bloom levels to generate</label>
          <div className="flex gap-2 mb-3">
            <button type="button"
              onClick={() => setMode("all")}
              className={`btn ${mode === "all" ? "btn-primary" : "btn-secondary"}`}>
              All 6 levels
            </button>
            <button type="button"
              onClick={() => setMode("custom")}
              className={`btn ${mode === "custom" ? "btn-primary" : "btn-secondary"}`}>
              Choose levels (up to {MAX_PICKED})
            </button>
          </div>
          {mode === "custom" && (
            <>
              <div className="flex flex-wrap gap-2">
                {BLOOM_LEVELS.map((l) => {
                  const on = pickedLevels.includes(l);
                  const atCap = !on && pickedLevels.length >= MAX_PICKED;
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => togglePickedLevel(l)}
                      disabled={atCap}
                      title={atCap ? `Up to ${MAX_PICKED} levels` : BLOOM_META[l].description}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                        on
                          ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                          : atCap
                            ? "border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed"
                            : "border-slate-300 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {BLOOM_META[l].label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs muted mt-2">
                {pickedLevels.length} of {MAX_PICKED} selected
                {pickedLevels.length === 0 ? " — pick at least one." : ""}
              </p>
            </>
          )}
        </div>

        <div>
          <label className="label">Questions per level</label>
          <input type="number" min={1} max={10} className="input w-32"
                 value={perLevel} onChange={(e) => setPerLevel(Math.max(1, Math.min(10, +e.target.value || 1)))} />
          <p className="text-xs muted mt-1">
            {mode === "all"
              ? `Total: ${perLevel * 6} questions`
              : `Total: ${perLevel * pickedLevels.length} question${perLevel * pickedLevels.length === 1 ? "" : "s"}`}
          </p>
        </div>

        <div>
          <label className="label flex items-center justify-between">
            <span>Numerical questions</span>
            <span className="text-sm text-emerald-700 font-semibold">{numericalPercent}%</span>
          </label>
          <input
            type="range" min={0} max={100} step={5}
            value={numericalPercent}
            onChange={(e) => setNumericalPercent(+e.target.value)}
            className="w-full accent-emerald-600"
          />
          <p className="text-xs muted mt-1">
            Target % of questions that should involve calculation, formulas, or quantitative reasoning. Ignored automatically for non-numerical topics (history, literature, etc.).
          </p>
        </div>

        {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

        <div className="flex justify-end">
          <button className="btn btn-primary" onClick={generate} disabled={busy}>
            {busy ? <><span className="spinner" /> Generating…</> : <><Sparkles size={16} /> Generate</>}
          </button>
        </div>
      </div>

      {summary && (
        <div className="card mt-6 fade-in">
          <h3 className="h2 mb-3">✅ Generation summary</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {BLOOM_LEVELS.map((l) => (
              <div key={l} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className={`badge badge-${l} mb-2`}>{BLOOM_META[l].label}</div>
                <div className="text-2xl font-bold">{summary[l] || 0}</div>
                <div className="text-xs muted">questions</div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center justify-between gap-3 flex-wrap">
            <p className="muted text-sm">
              Total: <strong className="text-slate-700">
                {Object.values(summary).reduce((a: number, b: number) => a + b, 0)}
              </strong> question{Object.values(summary).reduce((a: number, b: number) => a + b, 0) === 1 ? "" : "s"} added to your review queue.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => router.push("/teacher/review")}
            >
              Review questions →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
