"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { BLOOM_LEVELS, BLOOM_META, recommendedQuizMinutes, type BloomLevel } from "@/lib/bloom";
import { Sparkles, FileText, Image as ImageIcon, GraduationCap, Tag, Play, ScrollText } from "lucide-react";

type Source = "topic_only" | "topic_syllabus" | "notes" | "image" | "past_paper";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_MAX_DIM = 1600;
const IMAGE_QUALITY = 0.85;

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

export default function StudentGeneratePage() {
  const router = useRouter();

  // Default to "topic_only" so the form is immediately usable; past_paper stays
  // the first (highlighted) tile so it's visually featured.
  const [source, setSource] = useState<Source>("topic_only");
  const [topic, setTopic] = useState("");
  const [content, setContent] = useState("");
  const [className, setClassName] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [examLabel, setExamLabel] = useState("");

  const MAX_PICKED = 5;
  const [levelMode, setLevelMode] = useState<"all" | "custom">("all");
  const [pickedLevels, setPickedLevels] = useState<BloomLevel[]>(["understand", "apply"]);
  const [perLevel, setPerLevel] = useState(2);
  const [timeLimit, setTimeLimit] = useState(15);
  // Once the student manually edits the time field, stop auto-syncing the
  // recommendation so their explicit choice isn't quietly overwritten.
  const [timeManuallySet, setTimeManuallySet] = useState(false);
  const [numericalPercent, setNumericalPercent] = useState(0);

  // The actual levels we'll send: all 6 OR the custom subset
  const effectiveLevels = levelMode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;

  // Smart time recommendation. Built from the Bloom mix the student picked
  // (perLevel of each chosen level). Kept in sync with the time field
  // until the student manually edits it.
  const recommendedMinutes = useMemo(() => {
    const counts = {
      remember: 0, understand: 0, apply: 0,
      analyze: 0, evaluate: 0, create: 0,
    } as Record<BloomLevel, number>;
    for (const l of effectiveLevels) counts[l] = perLevel;
    return recommendedQuizMinutes(counts);
  }, [effectiveLevels, perLevel]);
  useEffect(() => {
    if (!timeManuallySet && recommendedMinutes > 0) {
      setTimeLimit(recommendedMinutes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedMinutes]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function togglePickedLevel(l: BloomLevel) {
    setPickedLevels((prev) => {
      if (prev.includes(l)) return prev.filter((x) => x !== l);
      if (prev.length >= MAX_PICKED) return prev;
      return BLOOM_LEVELS.filter((b) => prev.includes(b) || b === l);
    });
  }

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
    toast.success(source === "past_paper" ? `Past paper uploaded — ${f.name}` : `Image uploaded — ${f.name}`);
  }

  async function generate() {
    setErr(null);

    // Per-source validation
    if (source === "topic_only" && !topic.trim()) return setErr("Enter a topic.");
    if (source === "topic_syllabus" && (!topic.trim() || !className.trim())) {
      return setErr("Topic and class/grade are required.");
    }
    if (source === "notes" && content.trim().length < 50) {
      return setErr("Paste at least a paragraph (50+ chars) of notes.");
    }
    if (source === "image" && !imageFile) return setErr("Pick an image to generate from.");
    if (source === "past_paper" && !imageFile) return setErr("Upload a photo of the past question paper.");
    if (effectiveLevels.length === 0) return setErr("Pick at least one Bloom level.");

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");

      const body: Record<string, unknown> = {
        source,
        topic,
        levels: effectiveLevels,
        perLevel,
        timeLimit,
        numericalPercent,
      };
      if (source === "notes") body.content = content;
      if (source === "image" && imageFile) body.imageDataUrl = await downscaleToDataUrl(imageFile);
      if (source === "past_paper" && imageFile) {
        body.imageDataUrl = await downscaleToDataUrl(imageFile);
        body.examLabel = examLabel;
      }
      if (source === "topic_syllabus") {
        body.className = className;
        body.syllabus = syllabus;
      }

      const res = await fetch("/api/student/quick-test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed.");
      toast.success("Test generated successfully.");

      // Jump straight into the test
      router.push(`/student/quiz/${data.quizCode}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: Source; icon: React.ReactNode; label: string; desc: string; badge?: string }> = [
    { id: "past_paper",     icon: <ScrollText size={18} />,      label: "Past question paper",     desc: "Upload last year’s exam — get questions in the same style", badge: "🎯 Exam prep" },
    { id: "topic_only",     icon: <Tag size={18} />,             label: "Just a topic",            desc: "Quick practice on any subject" },
    { id: "topic_syllabus", icon: <GraduationCap size={18} />,   label: "Topic + class + syllabus",desc: "Aligned to your curriculum" },
    { id: "notes",          icon: <FileText size={18} />,        label: "From your notes",         desc: "Paste class notes or a chapter" },
    { id: "image",          icon: <ImageIcon size={18} />,       label: "From an image",           desc: "Photo of a textbook page, diagram, or notes" },
  ];

  const totalQs = effectiveLevels.length * perLevel;

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <h1 className="h1">New practice test</h1>
      <p className="muted mt-1">
        Pick a source, choose Bloom levels, generate. You&apos;ll start the test immediately after.
      </p>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 mt-6">
        {tabs.map((t) => {
          const on = source === t.id;
          const isFeatured = !!t.badge;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => { setSource(t.id); setErr(null); }}
              className={`relative text-left p-4 rounded-xl border transition ${
                on
                  ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                  : isFeatured
                    ? "border-amber-300 bg-amber-50/40 hover:bg-amber-50"
                    : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              {t.badge && !on && (
                <span className="absolute -top-2 right-3 text-[10px] uppercase tracking-wide font-bold text-amber-900 bg-amber-200 rounded-full px-2 py-0.5 shadow-sm">
                  {t.badge}
                </span>
              )}
              {t.badge && on && (
                <span className="absolute -top-2 right-3 text-[10px] uppercase tracking-wide font-bold text-emerald-900 bg-emerald-200 rounded-full px-2 py-0.5 shadow-sm">
                  {t.badge}
                </span>
              )}
              <div className="flex items-center gap-2 font-semibold mb-1">{t.icon} {t.label}</div>
              <div className="text-xs muted">{t.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="card mt-4 space-y-5">
        {source === "topic_only" && (
          <div>
            <label className="label">Topic</label>
            <input className="input" placeholder="e.g. Mitochondria"
                   value={topic} onChange={(e) => setTopic(e.target.value)} />
            <p className="text-xs muted mt-1">Questions are written from general knowledge of the topic.</p>
          </div>
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
            </div>
          </>
        )}

        {source === "notes" && (
          <>
            <div>
              <label className="label">Topic <span className="muted text-xs">(optional)</span></label>
              <input className="input" placeholder="e.g. Photosynthesis"
                     value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div>
              <label className="label">Paste your notes</label>
              <textarea className="textarea" rows={10}
                        placeholder="Paste a chapter, lesson notes, or summary..."
                        value={content} onChange={(e) => setContent(e.target.value)} />
              <p className="text-xs muted mt-1">{content.length} characters</p>
            </div>
          </>
        )}

        {source === "image" && (
          <>
            <div>
              <label className="label">Topic <span className="muted text-xs">(optional)</span></label>
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
                Photo of a textbook page, diagram, or your notes. PNG / JPEG / WebP, under 6 MB.
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

        {source === "past_paper" && (
          <>
            <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg space-y-1">
              <div><strong>Smart exam prep.</strong> Upload last year&apos;s exam, a mock paper, or a sample question paper. AI reads the questions, picks up on the difficulty and style, and generates fresh questions in the <em>same pattern</em> — so you practise against what you&apos;ll actually face.</div>
              <div className="text-xs">
                <strong>Mixed paper?</strong> No problem — MCQs, short-answer, essay, fill-in-the-blanks, problem-solving, anything goes. The AI extracts the topics being tested and gives you MCQs that cover the same ground at the same difficulty. (Output is always MCQs; we don&apos;t generate essay-style questions yet.)
              </div>
            </div>
            <div>
              <label className="label">Topic <span className="muted text-xs">(optional)</span></label>
              <input className="input" placeholder="e.g. Algebra, World History"
                     value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div>
              <label className="label">Exam / paper reference <span className="muted text-xs">(optional)</span></label>
              <input className="input" placeholder="e.g. CBSE Class 10 Boards 2023, JEE Main 2024 Paper 1"
                     value={examLabel} onChange={(e) => setExamLabel(e.target.value)} />
              <p className="text-xs muted mt-1">Helps the AI calibrate to the right exam style.</p>
            </div>
            <div>
              <label className="label">Upload the past paper</label>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onPickImage}
                className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-amber-600 file:text-white hover:file:bg-amber-700 cursor-pointer"
              />
              <p className="text-xs muted mt-1">
                Photo of a previous year&apos;s exam, mock test, or sample paper. PNG / JPEG / WebP, under 6 MB. Multi-page papers — upload one page at a time.
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

        <div>
          <label className="label">Which thinking levels do you want to drill?</label>
          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={() => setLevelMode("all")}
              className={`btn ${levelMode === "all" ? "btn-primary" : "btn-secondary"}`}
            >
              All 6 levels
            </button>
            <button
              type="button"
              onClick={() => setLevelMode("custom")}
              className={`btn ${levelMode === "custom" ? "btn-primary" : "btn-secondary"}`}
            >
              Choose levels (up to {MAX_PICKED})
            </button>
          </div>

          {levelMode === "custom" ? (
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
          ) : (
            <p className="text-xs muted">
              We&apos;ll cover all six: {BLOOM_LEVELS.map((l) => BLOOM_META[l].label).join(", ")}.
            </p>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Questions per level</label>
            <input type="number" min={1} max={10} className="input w-32"
                   value={perLevel} onChange={(e) => setPerLevel(Math.max(1, Math.min(10, +e.target.value || 1)))} />
            <p className="text-xs muted mt-1">Total: {totalQs} question{totalQs === 1 ? "" : "s"}</p>
          </div>
          <div>
            <label className="label">Time limit (minutes)</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={180}
                className="input w-32"
                value={timeLimit}
                onChange={(e) => {
                  setTimeLimit(Math.max(1, Math.min(180, +e.target.value || 1)));
                  setTimeManuallySet(true);
                }}
              />
              {timeManuallySet && recommendedMinutes > 0 && timeLimit !== recommendedMinutes && (
                <button
                  type="button"
                  className="text-xs text-emerald-700 font-semibold hover:underline"
                  onClick={() => { setTimeLimit(recommendedMinutes); setTimeManuallySet(false); }}
                  title="Use the suggested time"
                >
                  Use suggested ({recommendedMinutes} min)
                </button>
              )}
            </div>
            {recommendedMinutes > 0 && (
              <p className="text-xs muted mt-1">
                Suggested: <strong className="text-slate-700">{recommendedMinutes} min</strong> for these {totalQs} question{totalQs === 1 ? "" : "s"} · ~{Math.max(1, Math.round((timeLimit * 60) / Math.max(1, totalQs)))} sec/question at the current setting
              </p>
            )}
          </div>
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
            Target % of questions involving calculation or numbers. Auto-ignored for non-numerical topics (history, literature, etc.).
          </p>
        </div>

        {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

        <div className="flex justify-end">
          <button className="btn btn-primary" onClick={generate} disabled={busy}>
            {busy ? <><span className="spinner" /> Building your test…</> : <><Play size={16} /> Generate &amp; start</>}
          </button>
        </div>
      </div>

      <p className="muted text-xs mt-4 text-center flex items-center justify-center gap-1">
        <Sparkles size={12} /> Tests are saved to your library — find them again under <strong className="text-slate-600">My Tests</strong>.
      </p>
    </div>
  );
}
