"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import {
  ArrowLeft, Sparkles, Plus, Trash2, FileText, Tag, GraduationCap,
  Image as ImageIcon, ScrollText,
} from "lucide-react";
import Link from "next/link";

type QType = "mcq" | "true_false" | "fill_blank" | "short_answer" | "long_answer" | "numerical";
type Source = "topic_only" | "topic_syllabus" | "notes" | "image" | "past_paper";
type Section = { name: string; question_type: QType; count: number; marks_per_question: number };

const Q_TYPE_LABEL: Record<QType, string> = {
  mcq:           "Multiple choice (1 correct of 4)",
  true_false:    "True / False",
  fill_blank:    "Fill in the blank",
  short_answer:  "Short answer",
  long_answer:   "Long answer / essay",
  numerical:     "Numerical / problem-solving",
};

const PRESETS: Record<string, Section[]> = {
  custom: [],
  "Quick MCQ test (10 × 2m = 20)": [
    { name: "Section A — MCQ", question_type: "mcq", count: 10, marks_per_question: 2 },
  ],
  "Mixed test (small)": [
    { name: "Section A — MCQ",          question_type: "mcq",          count: 10, marks_per_question: 1 },
    { name: "Section B — Short answer", question_type: "short_answer", count: 5,  marks_per_question: 4 },
    { name: "Section C — Long answer",  question_type: "long_answer",  count: 2,  marks_per_question: 10 },
  ],
  "CBSE Class 12 style (~80m)": [
    { name: "Section A — MCQ",                question_type: "mcq",          count: 18, marks_per_question: 1 },
    { name: "Section B — Very short answer",  question_type: "fill_blank",   count: 7,  marks_per_question: 2 },
    { name: "Section C — Short answer",       question_type: "short_answer", count: 5,  marks_per_question: 3 },
    { name: "Section D — Long answer",        question_type: "long_answer",  count: 3,  marks_per_question: 5 },
    { name: "Section E — Case study",         question_type: "long_answer",  count: 2,  marks_per_question: 6 },
  ],
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_MAX_DIM = 1600;

async function downscale(file: File): Promise<string> {
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
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export default function NewPaperPage() {
  const router = useRouter();

  // Paper metadata
  const [paperName, setPaperName] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [classGrade, setClassGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [examDate, setExamDate] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [instructions, setInstructions] = useState("All questions are compulsory. Answers must be written legibly.");

  // Source
  const [source, setSource] = useState<Source>("topic_syllabus");
  const [topic, setTopic] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [notes, setNotes] = useState("");
  const [examLabel, setExamLabel] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Template — sections
  const [presetName, setPresetName] = useState("Mixed test (small)");
  const [sections, setSections] = useState<Section[]>(PRESETS["Mixed test (small)"]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const totalMarks = useMemo(
    () => sections.reduce((s, sec) => s + sec.count * sec.marks_per_question, 0),
    [sections]
  );
  const totalQuestions = useMemo(
    () => sections.reduce((s, sec) => s + sec.count, 0),
    [sections]
  );

  function applyPreset(name: string) {
    setPresetName(name);
    if (name !== "custom") setSections([...PRESETS[name]]);
  }

  function addSection() {
    setSections((s) => [...s, {
      name: `Section ${String.fromCharCode(65 + s.length)}`,
      question_type: "short_answer",
      count: 5,
      marks_per_question: 3,
    }]);
    setPresetName("custom");
  }

  function updateSection(i: number, patch: Partial<Section>) {
    setSections((s) => s.map((row, idx) => idx === i ? { ...row, ...patch } : row));
    setPresetName("custom");
  }

  function removeSection(i: number) {
    setSections((s) => s.filter((_, idx) => idx !== i));
    setPresetName("custom");
  }

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setImageFile(null);
    setImagePreview(null);
    if (!f) return;
    if (f.size > MAX_IMAGE_BYTES) { setErr("Image > 6 MB. Pick a smaller one."); toast.error("Image > 6 MB."); return; }
    setErr(null);
    setImageFile(f);
    const r = new FileReader();
    r.onload = () => setImagePreview(r.result as string);
    r.readAsDataURL(f);
    toast.success(`Image uploaded — ${f.name}`);
  }

  async function generate() {
    setErr(null);

    if (!paperName.trim()) return setErr("Give the paper a name.");
    if (sections.length === 0) return setErr("Add at least one section.");
    if (source === "topic_only" && !topic.trim()) return setErr("Enter a topic.");
    if (source === "topic_syllabus" && (!topic.trim() || !classGrade.trim())) return setErr("Topic and class are required for the syllabus source.");
    if (source === "notes" && notes.trim().length < 30) return setErr("Paste more notes (at least 30 characters).");
    if ((source === "image" || source === "past_paper") && !imageFile) return setErr("Upload an image.");

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");

      const body: Record<string, unknown> = {
        source, topic, syllabus, notes, examLabel, sections,
        paperName: paperName.trim(),
        schoolName: schoolName.trim(),
        classGrade: classGrade.trim(),
        subject: subject.trim(),
        examDate: examDate || null,
        durationMinutes,
        instructions,
      };
      if ((source === "image" || source === "past_paper") && imageFile) {
        body.imageDataUrl = await downscale(imageFile);
      }

      const res = await fetch("/api/papers/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      toast.success("Paper generated successfully.");
      router.push(`/teacher/papers/${data.paperId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/teacher/papers" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> All papers</Link>
      <h1 className="h1 mt-2 flex items-center gap-2"><FileText size={28} /> New exam paper</h1>
      <p className="muted mt-1">Define your template, point to a source, and AI generates a printable paper you can review.</p>

      {/* ============ PAPER METADATA ============ */}
      <div className="card mt-6">
        <h3 className="font-bold mb-3">Paper details</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Paper name</label>
            <input className="input" value={paperName} onChange={(e) => setPaperName(e.target.value)} placeholder="e.g. Mid-term Mathematics — Class 9" />
          </div>
          <div>
            <label className="label">Subject</label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Mathematics" />
          </div>
          <div>
            <label className="label">School name</label>
            <input className="input" value={schoolName} onChange={(e) => setSchoolName(e.target.value)} placeholder="e.g. Springfield High" />
          </div>
          <div>
            <label className="label">Class / grade</label>
            <input className="input" value={classGrade} onChange={(e) => setClassGrade(e.target.value)} placeholder="e.g. Class 9 — Section A" />
          </div>
          <div>
            <label className="label">Date</label>
            <input type="date" className="input" value={examDate} onChange={(e) => setExamDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Duration (min)</label>
            <input type="number" min={5} max={300} className="input" value={durationMinutes} onChange={(e) => setDurationMinutes(Math.max(5, Math.min(300, +e.target.value || 60)))} />
          </div>
        </div>
        <div className="mt-3">
          <label className="label">General instructions</label>
          <textarea className="textarea" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </div>
      </div>

      {/* ============ TEMPLATE ============ */}
      <div className="card mt-4">
        <h3 className="font-bold mb-3">Template</h3>
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <span className="text-xs muted">Start from</span>
          {Object.keys(PRESETS).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => applyPreset(name)}
              className={`text-xs px-3 py-1.5 rounded-full border font-medium transition ${
                presetName === name ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              {name === "custom" ? "Custom" : name}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {sections.map((s, i) => (
            <div key={i} className="grid sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end p-3 rounded-lg border border-slate-200 bg-slate-50/40">
              <div>
                <label className="label">Section name</label>
                <input className="input" value={s.name} onChange={(e) => updateSection(i, { name: e.target.value })} />
              </div>
              <div>
                <label className="label">Type</label>
                <select className="select" value={s.question_type} onChange={(e) => updateSection(i, { question_type: e.target.value as QType })}>
                  {(Object.keys(Q_TYPE_LABEL) as QType[]).map((k) => (
                    <option key={k} value={k}>{Q_TYPE_LABEL[k]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Count</label>
                <input type="number" min={1} max={50} className="input w-20" value={s.count} onChange={(e) => updateSection(i, { count: Math.max(1, Math.min(50, +e.target.value || 1)) })} />
              </div>
              <div>
                <label className="label">Marks each</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={1} max={50} className="input w-20" value={s.marks_per_question} onChange={(e) => updateSection(i, { marks_per_question: Math.max(1, Math.min(50, +e.target.value || 1)) })} />
                  <button type="button" onClick={() => removeSection(i)} className="btn btn-ghost text-red-600 p-2" title="Remove section"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="sm:col-span-4 text-xs muted">
                = <strong className="text-slate-700">{s.count * s.marks_per_question}</strong> marks · {Q_TYPE_LABEL[s.question_type]}
              </div>
            </div>
          ))}

          <button type="button" className="btn btn-secondary w-full" onClick={addSection}>
            <Plus size={14} /> Add section
          </button>
        </div>

        <div className="mt-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm flex items-center justify-between">
          <span><strong>Total: {totalQuestions} question{totalQuestions === 1 ? "" : "s"}, {totalMarks} marks</strong></span>
          <span className="muted text-xs">{durationMinutes} min</span>
        </div>
      </div>

      {/* ============ SOURCE ============ */}
      <div className="card mt-4">
        <h3 className="font-bold mb-3">Source</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2 mb-4">
          {[
            { id: "topic_syllabus" as Source, icon: <GraduationCap size={16} />, label: "Topic + class + syllabus" },
            { id: "topic_only" as Source,     icon: <Tag size={16} />,            label: "Just a topic" },
            { id: "notes" as Source,          icon: <FileText size={16} />,       label: "Notes" },
            { id: "image" as Source,          icon: <ImageIcon size={16} />,      label: "Image" },
            { id: "past_paper" as Source,     icon: <ScrollText size={16} />,     label: "Past paper" },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSource(t.id)}
              className={`text-sm flex items-center gap-2 px-3 py-2.5 rounded-lg border transition ${
                source === t.id ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {source === "topic_syllabus" && (
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Topic</label>
              <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Quadratic equations" />
            </div>
            <div>
              <label className="label">Syllabus / board <span className="muted text-xs">(optional)</span></label>
              <input className="input" value={syllabus} onChange={(e) => setSyllabus(e.target.value)} placeholder="e.g. CBSE, IGCSE, IB MYP" />
            </div>
          </div>
        )}

        {source === "topic_only" && (
          <div>
            <label className="label">Topic</label>
            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Photosynthesis" />
          </div>
        )}

        {source === "notes" && (
          <>
            <div>
              <label className="label">Topic <span className="muted text-xs">(optional)</span></label>
              <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div className="mt-3">
              <label className="label">Paste your notes / chapter</label>
              <textarea className="textarea" rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <p className="text-xs muted mt-1">{notes.length} characters</p>
            </div>
          </>
        )}

        {(source === "image" || source === "past_paper") && (
          <>
            <div>
              <label className="label">Topic <span className="muted text-xs">(optional)</span></label>
              <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            {source === "past_paper" && (
              <div className="mt-3">
                <label className="label">Exam reference <span className="muted text-xs">(optional)</span></label>
                <input className="input" value={examLabel} onChange={(e) => setExamLabel(e.target.value)} placeholder="e.g. CBSE Class 10 Boards 2023" />
              </div>
            )}
            <div className="mt-3">
              <label className="label">Upload image</label>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onPickImage} className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-emerald-600 file:text-white hover:file:bg-emerald-700 cursor-pointer" />
              {imagePreview && (
                <div className="mt-3 rounded-lg overflow-hidden border border-slate-200 max-w-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imagePreview} alt="preview" className="block w-full" />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {err && <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

      <div className="flex justify-end mt-4">
        <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
          {busy ? <><span className="spinner" /> Building paper… (45–90s)</> : <><Sparkles size={16} /> Generate paper</>}
        </button>
      </div>
    </div>
  );
}
