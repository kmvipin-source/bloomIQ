"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { Sparkles, FileText, Image as ImageIcon, GraduationCap, Tag, Zap, BookOpenCheck, ScanSearch, Trophy, BookMarked, LifeBuoy, Wand2, Users, Briefcase, Cpu, Cloud, ServerCog } from "lucide-react";
// LearnerProfilePrompt (the inline "K-12 / Competitive exam / Professional"
// pill that used to live on this page) has been removed. learner_profile
// is now sourced from the teacher's own profile.learner_profile, which
// is auto-derived from their exam_goal at goal-pick time (single capture
// in StudentGoalPicker). We still need the LearnerProfile TYPE here for
// the topic-placeholder + skill-detection logic, so we import the type
// only (no component import).
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";
import { placeholderTopic } from "@/lib/topicSuggestions";
import { detectSkillFromTopic } from "@/lib/skillDetectors";
import {
  shouldUseCompetitiveExamFraming,
  detectExamFromTopic,
  EXAM_DETECTORS,
  type ExamMeta,
} from "@/lib/examDetectors";
import GenerateContextChips, { type GenerateContext } from "@/components/GenerateContextChips";
// 2026-05-13 evening: audience-level is fully optional (no profile-driven default).

type Source = "notes" | "image" | "topic_syllabus" | "topic_only";

// Client-side competitive-exam detector. Mirrors the backend logic in
// app/api/generate/route.ts and app/api/student/quick-test/route.ts.
type ExamDefault = {
  displayName: string;
  defaultNumericalPercent: number;
  rationale: string;
  supportedBloomLevels: BloomLevel[];
};
const EXAM_DEFAULTS: Record<string, ExamDefault> = {
  CAT:    { displayName: "CAT",          defaultNumericalPercent: 35, rationale: "Quantitative Aptitude is roughly one-third of the paper.",                                supportedBloomLevels: ["apply", "analyze", "evaluate"] },
  JEE:    { displayName: "JEE",          defaultNumericalPercent: 70, rationale: "Physics + Math + parts of Chemistry are heavily numerical.",                              supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"] },
  NEET:   { displayName: "NEET",         defaultNumericalPercent: 30, rationale: "Physics + parts of Chemistry are numerical; Biology is mostly conceptual.",               supportedBloomLevels: ["remember", "understand", "apply", "analyze"] },
  GMAT:   { displayName: "GMAT",         defaultNumericalPercent: 40, rationale: "Quant + Data Insights are numerical; Verbal is not.",                                     supportedBloomLevels: ["apply", "analyze", "evaluate"] },
  GRE:    { displayName: "GRE",          defaultNumericalPercent: 50, rationale: "Quantitative Reasoning is half the test.",                                                supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"] },
  UPSC:   { displayName: "UPSC Prelims", defaultNumericalPercent: 10, rationale: "GS is conceptual; CSAT has some quant + reasoning.",                                      supportedBloomLevels: ["remember", "understand", "apply", "analyze"] },
  IELTS:  { displayName: "IELTS",        defaultNumericalPercent: 0,  rationale: "Pure language test — no numerical content.",                                              supportedBloomLevels: ["understand", "apply", "analyze"] },
  TOEFL:  { displayName: "TOEFL",        defaultNumericalPercent: 0,  rationale: "Pure language test — no numerical content.",                                              supportedBloomLevels: ["understand", "apply", "analyze"] },
  CLAT:   { displayName: "CLAT",         defaultNumericalPercent: 10, rationale: "Quantitative Techniques is one of five sections.",                                        supportedBloomLevels: ["remember", "understand", "apply", "analyze"] },
  BITSAT: { displayName: "BITSAT",       defaultNumericalPercent: 70, rationale: "Physics + Chemistry + Math dominate; English/Logical small.",                             supportedBloomLevels: ["understand", "apply", "analyze"] },
  SAT:    { displayName: "SAT",          defaultNumericalPercent: 50, rationale: "Math is half the SAT; Reading & Writing the other half.",                                supportedBloomLevels: ["apply", "analyze"] },
  GATE:   { displayName: "GATE",         defaultNumericalPercent: 70, rationale: "Engineering Mathematics + subject section are highly numerical.",                         supportedBloomLevels: ["apply", "analyze", "evaluate"] },
  NDA:    { displayName: "NDA",          defaultNumericalPercent: 50, rationale: "Mathematics is half; General Ability the other half.",                                    supportedBloomLevels: ["remember", "understand", "apply"] },
  CUET:   { displayName: "CUET",         defaultNumericalPercent: 30, rationale: "Mix varies by chosen subjects; quant is part of General Test.",                            supportedBloomLevels: ["remember", "understand", "apply"] },
};
function detectExamDefault(topic: string): ExamDefault | null {
  if (!topic) return null;
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) if (EXAM_DEFAULTS[t]) return EXAM_DEFAULTS[t];
  return null;
}

// -------------------------------------------------------------------------
// INTENT PRESETS — narrow the teacher's focus on landing.
// -------------------------------------------------------------------------
// The teacher analog of the student's "What are you preparing for?" picker.
// Modern AI tools (Notion, Linear, Loom) all do this — six outcome-shaped
// chips at the top, each pre-fills Bloom mix + per-level count + a
// rationale caption so the teacher can see what the chip "thought" and
// override fearlessly. Source (notes / image / topic) stays orthogonal —
// the teacher picks that separately.
//
// Defaults were chosen empirically from common K-12 + competitive-exam
// scenarios. Each chip is a soft narrowing, not a hard gate; once
// applied, every dial is still editable.
type Intent = {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  blueprint: {
    mode: "all" | "custom";
    pickedLevels: BloomLevel[];
    perLevel: number;
    rationale: string;
  };
};
const INTENTS_K12: Intent[] = [
  { id: "formative", label: "Quick formative check", description: "5-min post-class pulse", icon: <Zap size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["remember", "understand"], perLevel: 3,
      rationale: "Short, recall-and-comprehension only — ideal for a 5-minute end-of-class temperature check." } },
  { id: "chapter_end", label: "Chapter-end test", description: "Balanced 12-question summary", icon: <BookOpenCheck size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["understand", "apply", "analyze"], perLevel: 4,
      rationale: "Mid-Bloom mix: confirms students can both grasp and apply the chapter's ideas, not just recall them." } },
  { id: "diagnostic", label: "Diagnostic — find weak spots", description: "All Bloom levels, evenly", icon: <ScanSearch size={16} />,
    blueprint: { mode: "all", pickedLevels: [], perLevel: 2,
      rationale: "Even spread across all six Bloom levels — surfaces exactly which kinds of thinking the class struggles with." } },
  { id: "mock_paper", label: "Mock paper (competitive exam)", description: "Detects CAT/JEE/NEET/etc. from topic", icon: <Trophy size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze", "evaluate"], perLevel: 5,
      rationale: "Exam-style depth: Apply / Analyze / Evaluate. Type the exam name (CAT, JEE, NEET) in Topic and the form auto-tunes." } },
  { id: "homework", label: "Homework set", description: "Take-home practice, deeper", icon: <BookMarked size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze"], perLevel: 4,
      rationale: "Apply / Analyze focus — students have time at home for the kind of thinking that doesn't fit a 5-minute window." } },
  { id: "reteach", label: "Re-teach / remediation", description: "Foundations for struggling students", icon: <LifeBuoy size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["remember", "understand"], perLevel: 4,
      rationale: "Foundations only — Remember / Understand levels rebuild basics for students who need a second pass." } },
];

const INTENTS_CORPORATE: Intent[] = [
  { id: "onboarding_check", label: "Onboarding skill check", description: "Day-1 baseline for new joiners", icon: <Briefcase size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["remember", "understand", "apply"], perLevel: 3,
      rationale: "Light end-to-end coverage of basics — calibrates where to start training new joiners." } },
  { id: "cert_prep", label: "Certification prep", description: "AWS/Azure/GCP/SAP-style mock", icon: <Trophy size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze", "evaluate"], perLevel: 5,
      rationale: "Cert-style depth: scenario-driven Apply / Analyze. Type the cert name (AWS, GCP, SAP, ServiceNow) in Topic." } },
  { id: "code_review", label: "Code review drill", description: "Read, find the bug, fix it", icon: <Cpu size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["analyze", "evaluate"], perLevel: 4,
      rationale: "Analyze / Evaluate: high-friction code-reading questions. Strong signal for senior-level competence." } },
  { id: "architecture", label: "Architecture / design scenario", description: "Pick the right approach", icon: <Cloud size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["analyze", "evaluate", "create"], perLevel: 3,
      rationale: "Evaluate / Create: real-world scenarios with multiple defensible answers. Tests judgement, not memory." } },
  { id: "debug_practice", label: "Hands-on debugging", description: "Stack trace → root cause", icon: <ServerCog size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze"], perLevel: 4,
      rationale: "Apply / Analyze: stack traces, error messages, log snippets — diagnose the failure mode." } },
];

const INTENTS_EXAM: Intent[] = [
  INTENTS_K12.find((i) => i.id === "mock_paper")!,
  INTENTS_K12.find((i) => i.id === "diagnostic")!,
  INTENTS_K12.find((i) => i.id === "formative")!,
  INTENTS_K12.find((i) => i.id === "reteach")!,
];

function intentsForProfile(p: LearnerProfile | null): Intent[] {
  if (p === "corporate") return INTENTS_CORPORATE;
  if (p === "competitive_exam") return INTENTS_EXAM;
  return INTENTS_K12;
}

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
  // Generate-context-v2 (2026-05-13). Same as /student/generate.
  const [genContext, setGenContext] = useState<GenerateContext>({
    audience_level: null,
    sub_topics: [],
    additional_focus: "",
  });
  const [content, setContent] = useState("");
  const [className, setClassName] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const [mode, setMode] = useState<"all" | "custom">("all");
  const [pickedLevels, setPickedLevels] = useState<BloomLevel[]>(["understand"]);
  const [numericalPercent, setNumericalPercent] = useState(0);
  // Stop overriding numerical % once the teacher drags the slider.
  const [numericalManuallySet, setNumericalManuallySet] = useState(false);
  const MAX_PICKED = 5;

  // Detect competitive exam from topic and auto-suggest numerical %.
  const examDefault = useMemo(() => detectExamDefault(topic), [topic]);
  useEffect(() => {
    if (examDefault && !numericalManuallySet) {
      setNumericalPercent(examDefault.defaultNumericalPercent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examDefault]);

  // 2026-05-14 — same topic-vs-syllabus / Bloom-aware / pre-flight UX
  // suite that landed on /student/generate, now applied to /teacher/generate.
  // Teachers don't have an exam_goal field, so examMeta comes from topic
  // text only. EXAM_DETECTORS is the single source of truth.
  const examMeta = useMemo<ExamMeta | null>(() => detectExamFromTopic(topic), [topic]);
  void EXAM_DETECTORS; // referenced for type-only; future "coaching mode" lookup hook

  // LLM-validated topic-vs-exam-syllabus warning. Same /api/topic-validate
  // route the student page uses. Fires only when (a) examMeta exists and
  // (b) the topic is ≥3 chars, debounced 800 ms. Fail-open on any error.
  const [topicValidation, setTopicValidation] = useState<{
    loading: boolean;
    result: { valid: boolean; reason: string; suggestedExam: string | null } | null;
  }>({ loading: false, result: null });
  useEffect(() => {
    if (!examMeta || (topic || "").trim().length < 3) {
      setTopicValidation({ loading: false, result: null });
      return;
    }
    const controller = new AbortController();
    setTopicValidation((s) => ({ ...s, loading: true }));
    const handle = setTimeout(async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const res = await fetch("/api/topic-validate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            topic: topic.trim(),
            examName: examMeta.name,
            examDescription: examMeta.description,
            examSections: examMeta.sections,
          }),
          signal: controller.signal,
        });
        const j = (await res.json()) as {
          valid?: boolean;
          reason?: string;
          suggestedExam?: string | null;
        };
        setTopicValidation({
          loading: false,
          result: {
            valid: j.valid !== false,
            reason: String(j.reason || ""),
            suggestedExam: j.suggestedExam ? String(j.suggestedExam) : null,
          },
        });
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") {
          setTopicValidation({ loading: false, result: null });
        }
      }
    }, 800);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [topic, examMeta]);

  // Effective levels — used to warn when the teacher picks levels the
  // detected exam doesn't actually test.
  const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;

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

  // Active intent ID (null = no intent picked = current default behavior).
  // Clicking a chip applies its blueprint; teacher can still tweak
  // anything after, and the active highlight stays so they can see what
  // they started from.
  // ---- Q2: Learner profile (drives intent set + skill detector) --
  // Declared BEFORE activeIntent useMemo because that useMemo reads
  // `intents` — TDZ would fire if this came later.
  //
  // Previously sourced from the inline LearnerProfilePrompt pill on
  // this page. That pill was removed when we consolidated learning-
  // context capture into StudentGoalPicker. learner_profile is now
  // read once from profiles.learner_profile (auto-derived from the
  // teacher's exam_goal at pick time). Also pulling exam_goal so the
  // topic-placeholder helper can disambiguate CAT vs NEET vs JEE
  // (was previously hardcoded to "NEET Biology" for everyone in the
  // competitive_exam bucket — bug Vipin caught 2026-05-12).
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  const [examGoal, setExamGoal] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data: prof } = await sb
          .from("profiles")
          .select("learner_profile, exam_goal")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as { learner_profile: string | null; exam_goal: string | null } | null;
        const lp = row?.learner_profile;
        if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
          setLearnerProfile(lp);
        }
        if (row?.exam_goal) setExamGoal(row.exam_goal);
        // Derive default audience level for the generate-context chips.
        // Teacher's own goal/profile is a reasonable proxy for the class
        // they teach (school-mode teachers are typically corporate trainers
        // or k12 teachers, both of which map sensibly via the same logic).
        // audience-level default removed 2026-05-13 evening
      } catch { /* non-fatal — placeholders fall back to defaults */ }
    })();
  }, []);
  const intents = useMemo(() => intentsForProfile(learnerProfile), [learnerProfile]);
  const skillDefault = useMemo(
    () => (learnerProfile === "corporate" ? detectSkillFromTopic(topic) : null),
    [topic, learnerProfile],
  );

  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);
  const activeIntent = useMemo(
    () => intents.find((i) => i.id === activeIntentId) || null,
    [activeIntentId, intents],
  );

  // Goal-aware topic placeholders. All three now key off exam_goal (granular)
  // first and fall back to learner_profile, so a CAT teacher sees CAT
  // examples and a JEE teacher sees JEE examples — previously both saw
  // whichever happened to be hardcoded in the competitive_exam branch.
  function topicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }
  function syllabusTopicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }
  function topicOnlyPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }

  function applyIntent(intent: Intent) {
    setActiveIntentId(intent.id);
    setMode(intent.blueprint.mode);
    setPickedLevels(intent.blueprint.pickedLevels);
    setPerLevel(intent.blueprint.perLevel);
    setErr(null);
    setSummary(null);
  }

  // ---- Q1 V1: Class scope (optional teacher narrowing) -----------
  type ClassOption = { id: string; name: string; grade?: string | null;
    section?: string | null; subject?: string | null; myRole?: "primary" | "co" | "acting" };
  const [teacherClasses, setTeacherClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const r = await fetch("/api/teacher/classes", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = await r.json() as { classes?: ClassOption[] };
        if (!cancelled && Array.isArray(j.classes)) setTeacherClasses(j.classes);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const targetClass = useMemo(
    () => teacherClasses.find((c) => c.id === targetClassId) || null,
    [teacherClasses, targetClassId],
  );



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
    // 2026-05-14: don't require class/grade when the topic is a competitive
    // exam. Uses the shared shouldUseCompetitiveExamFraming helper from
    // lib/examDetectors so the rule stays in sync with /student/generate +
    // the backend. Teachers don't have an exam_goal field yet, so only the
    // topic-text branch fires for this surface — but threading the helper
    // through means a future "coaching mode" toggle has a single seam.
    const _isExamLikeTopic = shouldUseCompetitiveExamFraming({ topic, learnerProfile: null, examGoal: null });
    if (source === "topic_syllabus" && (!topic.trim() || (!_isExamLikeTopic && !className.trim()))) {
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
        // Generate-context-v2 (2026-05-13).
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
      };
      if (source === "notes") body.content = content;
      if (source === "image" && imageFile) {
        body.imageDataUrl = await downscaleToDataUrl(imageFile);
      }
      if (source === "topic_syllabus") {
        body.className = className;
        body.syllabus = syllabus;
      }
      // Forward the chosen class so the API can tag generated questions
      // with class_id for later filtering. Extra-key tolerant on /api/generate
      // — the server ignores unknown fields until topic-suggestion wiring
      // lands.
      if (targetClassId) body.class_id = targetClassId;

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
      // Off-topic textbox guard (2026-05-13).
      if (data.focus_warning) toast.error(data.focus_warning);

      // Shortfall transparency: mirror student/generate. The API returns
      // `total` (delivered) and `summary` (per-Bloom counts). Hard-fail
      // when zero; warn loudly when delivered < requested so the teacher
      // sees per-level counts instead of a generic success toast.
      const deliveredTotal = Number(data.total ?? 0);
      // Total requested = perLevel × number-of-target-levels. In "all" mode
      // the API targets every Bloom level (6); in "custom" it targets only
      // the picked ones. Mirrors the same math the API does.
      const levelCount = mode === "all" ? 6 : pickedLevels.length;
      const requestedTotal = perLevel * levelCount;
      if (deliveredTotal === 0) {
        throw new Error(
          "AI returned zero usable questions. Try a more specific topic, " +
          "fewer levels, or check that your topic aligns with the chosen syllabus."
        );
      }
      setSummary(data.summary);
      if (deliveredTotal < requestedTotal) {
        const perLevelStr = data.summary
          ? Object.entries(data.summary as Record<string, number>)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")
          : "n/a";
        toast.error(
          `Generated ${deliveredTotal} of ${requestedTotal} (short by ${requestedTotal - deliveredTotal}). ` +
          `Per level: ${perLevelStr}. Likely causes: niche topic / dedup / answer-leaks. ` +
          `Try a more specific topic or fewer levels.`,
        );
      } else {
        toast.success("Questions generated successfully.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: Source; icon: React.ReactNode; label: string; desc: string }> = [
    // Order matters: teachers reach for "Topic + syllabus" most often
    // (curriculum-driven), then "Just a topic" (quick), then notes/image
    // (more advanced source flows). Keep this order in sync with the
    // student generate page below.
    { id: "topic_syllabus",  icon: <GraduationCap size={18} />,   label: "Topic + class + syllabus",  desc: "Aligned to a board / curriculum" },
    { id: "topic_only",      icon: <Tag size={18} />,             label: "Just a topic",              desc: "Quick generation by subject" },
    { id: "notes",           icon: <FileText size={18} />,        label: "From notes",                desc: "Paste a chapter or lesson plan" },
    { id: "image",           icon: <ImageIcon size={18} />,       label: "From an image",             desc: "Photo of a page or diagram" },
  ];

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <h1 className="h1">Generate questions</h1>
      <p className="muted mt-1 text-sm">
        AI writes new multiple-choice questions for you. They land in <strong>Review Pending</strong> first; once you approve them they&apos;re available to <strong>Build &amp; Assign Tests</strong>.
      </p>

      {/* LearnerProfilePrompt removed (2026-05-12) — see top of file.
          learner_profile is now sourced via useEffect above from
          profiles.learner_profile, auto-derived from the teacher's
          exam_goal at pick time. */}

      {/* ---------- Q1 V1: Class scope (optional) ---------- */}
      {teacherClasses.length > 0 && (
        <div className="card mt-5">
          <div className="flex items-center gap-2 mb-2">
            <Users size={16} className="text-emerald-600" />
            <h2 className="font-semibold text-sm">Which class is this for?</h2>
            <span className="text-xs muted ml-auto">Optional — focuses what we generate</span>
          </div>
          <select
            className="select w-full text-sm"
            value={targetClassId}
            onChange={(e) => setTargetClassId(e.target.value)}
          >
            <option value="">All classes (general library)</option>
            {teacherClasses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.section ? ` · ${c.section}` : ""}{c.grade ? ` · Grade ${c.grade}` : ""}
                {c.myRole && c.myRole !== "primary" ? ` (${c.myRole})` : ""}
              </option>
            ))}
          </select>
          {targetClass && (
            <div className="mt-2 text-xs text-emerald-800 bg-emerald-50/60 border border-emerald-200 rounded-lg px-3 py-2">
              <strong>Tagging questions to {targetClass.name}{targetClass.section ? " · " + targetClass.section : ""}.</strong>{" "}
              They will surface first when you build a test for this class.
            </div>
          )}
        </div>
      )}

      {/* ---------- INTENT PICKER (Q1) ----------
          Outcome-shaped chips that pre-fill Bloom mode + level mix +
          per-level count. Soft narrowing — the teacher can still edit
          anything below. Hidden in the most subtle way: collapsed to a
          one-line "Skip — set everything yourself" link if they don't
          want guidance. Default is to show. */}
      <div className="card mt-5">
        <div className="flex items-center gap-2 mb-3">
          <Wand2 size={16} className="text-emerald-600" />
          <h2 className="font-semibold text-sm">What kind of test are you making?</h2>
          <span className="text-xs muted ml-auto">Optional — pre-fills the form below</span>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {intents.map((intent) => {
            const on = activeIntentId === intent.id;
            return (
              <button
                key={intent.id}
                type="button"
                onClick={() => applyIntent(intent)}
                className={`text-left p-3 rounded-lg border transition ${
                  on
                    ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                    : "border-slate-200 hover:bg-slate-50"
                }`}
                aria-pressed={on}
              >
                <div className="flex items-center gap-1.5 font-semibold text-sm mb-0.5">
                  <span className={on ? "text-emerald-700" : "text-slate-500"}>{intent.icon}</span>
                  {intent.label}
                </div>
                <div className="text-xs muted">{intent.description}</div>
              </button>
            );
          })}
        </div>

        {activeIntent && (
          <div className="mt-3 text-xs text-slate-700 bg-emerald-50/60 border border-emerald-200 rounded-lg px-3 py-2">
            <strong className="text-emerald-800">Why this setup:</strong>{" "}
            {activeIntent.blueprint.rationale}{" "}
            <button
              type="button"
              className="text-emerald-700 font-semibold hover:underline ml-1"
              onClick={() => setActiveIntentId(null)}
              title="Drop the preset and start from scratch"
            >
              Clear
            </button>
          </div>
        )}
      </div>

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
              <input className="input" placeholder={topicPlaceholder()}
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
              <input className="input" placeholder={`Topic — ${topicPlaceholder().replace(/^e\.g\. /, "")}`}
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

        {source === "topic_syllabus" && (() => {
          const examLike = shouldUseCompetitiveExamFraming({ topic, learnerProfile: null, examGoal: null });
          return (
            <>
              <div className={examLike ? "" : "grid sm:grid-cols-2 gap-3"}>
                <div>
                  <label className="label">Topic</label>
                  <input className="input" placeholder={syllabusTopicPlaceholder()}
                         value={topic} onChange={(e) => setTopic(e.target.value)} />
                </div>
                {!examLike && (
                  <div>
                    <label className="label">Class / grade</label>
                    <input className="input" placeholder="e.g. Class 9 / Grade 9"
                           value={className} onChange={(e) => setClassName(e.target.value)} />
                  </div>
                )}
              </div>
              {!examLike ? (
                <div>
                  <label className="label">Syllabus / board <span className="muted text-xs">(optional)</span></label>
                  <input className="input" placeholder="e.g. CBSE, ICSE, Cambridge IGCSE, NCERT Chapter 9"
                         value={syllabus} onChange={(e) => setSyllabus(e.target.value)} />
                  <p className="text-xs muted mt-1">If provided, questions are aligned to this curriculum and class level.</p>
                </div>
              ) : (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                  <strong>Competitive-exam topic detected.</strong> Class and syllabus aren&apos;t needed — questions will be in the style of the actual exam paper.
                </p>
              )}
            </>
          );
        })()}

        {/* LLM-validated topic-vs-syllabus warning. Fires only when the
            topic resolves to a known exam (via detectExamFromTopic) AND
            the LLM marks the typed topic as off-syllabus. Same /api/topic-
            validate route the student page uses; debounced 800 ms. */}
        {topicValidation.result &&
          !topicValidation.result.valid &&
          examMeta &&
          (source === "topic_only" || source === "topic_syllabus") && (
            <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
              <span className="font-bold">⚠</span>
              <div className="flex-1">
                <strong>{topicValidation.result.reason}</strong>
                {topicValidation.result.suggestedExam ? (
                  <>{" "}This topic fits <strong>{topicValidation.result.suggestedExam}</strong> better — consider that exam if you intended a mock paper.</>
                ) : (
                  <>{" "}If this is intentional (cross-prep, mixed-subject test), proceed — the test will still be generated.</>
                )}
              </div>
            </div>
          )}
        {source === "topic_only" && (
          <div>
            <label className="label">Topic</label>
            <input className="input" placeholder={topicOnlyPlaceholder()}
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
                  const examUnsupported =
                    !!examDefault && !examDefault.supportedBloomLevels.includes(l);
                  const disabled = atCap || examUnsupported;
                  const tooltip = examUnsupported
                    ? `${examDefault!.displayName} papers don\u2019t test ${BLOOM_META[l].label}-level questions.`
                    : atCap
                      ? `Up to ${MAX_PICKED} levels`
                      : BLOOM_META[l].description;
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => { if (!examUnsupported) togglePickedLevel(l); }}
                      disabled={disabled}
                      title={tooltip}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                        on && !examUnsupported
                          ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                          : examUnsupported
                            ? "border-slate-200 text-slate-300 bg-slate-50 line-through cursor-not-allowed"
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
          {/* Per-exam Bloom level warning. Same pattern as the student page. */}
          {examDefault && (() => {
            const supported = new Set(examDefault.supportedBloomLevels);
            const unsupported = effectiveLevels.filter((l) => !supported.has(l));
            if (unsupported.length === 0) return null;
            const supportedLabels = examDefault.supportedBloomLevels.map((l) => BLOOM_META[l].label).join(", ");
            const unsupportedLabels = unsupported.map((l) => BLOOM_META[l].label).join(", ");
            return (
              <p className="text-xs mt-2" style={{ color: "var(--brand-700, #047857)" }}>
                <strong>Heads up:</strong> {examDefault.displayName} papers don&apos;t test {unsupportedLabels} levels — those questions wouldn&apos;t look like the real exam. We&apos;ll skip them and generate {supportedLabels} only.
              </p>
            );
          })()}
          {skillDefault && (
            <p className="text-xs mt-2" style={{ color: "var(--brand-700, #047857)" }}>
              <strong>Detected:</strong> {skillDefault.displayName} — {skillDefault.rationale}
            </p>
          )}
        </div>

        {/* Generate-context-v2 (2026-05-13): audience-level chip +
            auto-detected sub-topic chips + optional "Anything specific?"
            textbox. Shared component with /student/generate. */}
        <GenerateContextChips
          topic={topic}
          onChange={setGenContext}
          disabled={busy}
        />

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
            onChange={(e) => { setNumericalPercent(+e.target.value); setNumericalManuallySet(true); }}
            className="w-full accent-emerald-600"
          />
          {/* Numerical % caption — fixed 2026-05-14: when manually-set value
              EQUALS the suggested value, "Use suggested" is a no-op so we
              hide that branch and show a quiet "your slider is aligned"
              instead. Mirrors the fix on /student/generate. */}
          {examDefault && !numericalManuallySet ? (
            <p className="text-xs mt-1" style={{ color: "var(--brand-700, #047857)" }}>
              Set to <strong>{examDefault.defaultNumericalPercent}%</strong> to match {examDefault.displayName} — {examDefault.rationale} Drag the slider to override.
            </p>
          ) : examDefault && numericalManuallySet && numericalPercent !== examDefault.defaultNumericalPercent ? (
            <p className="text-xs muted mt-1">
              {examDefault.displayName} usually has ~{examDefault.defaultNumericalPercent}% numerical content. You&apos;ve set yours to {numericalPercent}%.{" "}
              <button
                type="button"
                className="text-emerald-700 font-semibold hover:underline"
                onClick={() => { setNumericalPercent(examDefault.defaultNumericalPercent); setNumericalManuallySet(false); }}
              >
                Use suggested
              </button>
            </p>
          ) : examDefault ? (
            <p className="text-xs muted mt-1">
              {examDefault.displayName} typically tests ~{examDefault.defaultNumericalPercent}% numerical questions — your slider is aligned.
            </p>
          ) : (
            <p className="text-xs muted mt-1">
              Target % of questions that should involve calculation, formulas, or quantitative reasoning. Ignored automatically for non-numerical topics (history, literature, etc.).
            </p>
          )}
        </div>

        {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

        {/* Pre-flight validation + summary pill (2026-05-14). Disables the
            Generate button when the form can't generate yet, with an
            inline amber reason so the teacher doesn't click and bounce
            off a 400. Shows "Will generate X questions" so the commit is
            visible before the click. Mirrors the same pattern on the
            student page. */}
        {(() => {
          const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
          const totalQs = effectiveLevels.length * perLevel;
          let reason: string | null = null;
          if (source === "topic_only" && !topic.trim()) reason = "Enter a topic above.";
          else if (source === "topic_syllabus" && !topic.trim()) reason = "Topic is required.";
          else if (source === "topic_syllabus" && !shouldUseCompetitiveExamFraming({ topic, learnerProfile: null, examGoal: null }) && !className.trim()) reason = "Add a class/grade for syllabus-aligned tests.";
          else if (source === "notes" && content.trim().length < 50) reason = "Paste at least a paragraph of notes (50+ chars).";
          else if (source === "image" && !imageFile) reason = "Pick an image to generate from.";
          else if (mode === "custom" && (pickedLevels.length < 1 || pickedLevels.length > MAX_PICKED)) reason = `Pick between 1 and ${MAX_PICKED} Bloom levels.`;
          else if (effectiveLevels.length === 0) reason = "Pick at least one Bloom level.";
          else if (totalQs <= 0) reason = "Question count must be at least 1.";
          const canGenerate = !reason && !busy;
          return (
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs muted">
                {reason ? (
                  <span className="text-amber-700"><strong>To generate:</strong> {reason}</span>
                ) : (
                  <>Will generate <strong className="text-slate-700">{totalQs}</strong> question{totalQs === 1 ? "" : "s"}</>
                )}
              </p>
              <button type="button" className="btn btn-primary" onClick={generate} disabled={!canGenerate}>
                {busy ? <><span className="spinner" /> Generating…</> : <><Sparkles size={16} /> Generate</>}
              </button>
            </div>
          );
        })()}
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
