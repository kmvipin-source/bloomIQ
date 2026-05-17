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
import {
  validateGenerationRequest,
  groupedTeachingContextOptions,
  defaultTeachingContext,
  type IntentId as TCIntentId,
} from "@/lib/teachingContext";
import { categoryBucket } from "@/lib/questionCategory";
// 2026-05-13 evening: audience-level is fully optional (no profile-driven default).
// F143 note (QA): the "Advanced" disclosure (numerical %, intent presets,
// per-level overrides) used to be untitled — first-time teachers thought
// the page was simpler than it is. When next touching the disclosure JSX,
// add a heading like "Advanced — fine-tune the mix" and a one-line
// description so it's discoverable without being intimidating.

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
  { id: "mock_paper", label: "Full mock paper", description: "Exam-style paper aligned to your teaching context", icon: <Trophy size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze", "evaluate"], perLevel: 5,
      rationale: "Exam-style depth: Apply / Analyze / Evaluate. The teaching-context picker above tells the AI which exam style to mimic — this intent biases toward the deep Bloom levels real entrance exams test." } },
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
        if (controller.signal.aborted) return;
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
  // F125 fix (QA): numerical-percent slider only meaningful for the
  // apply / analyse / evaluate Bloom levels (remember/understand questions
  // don't carry numerical content). Used to disable the slider below.
  const f125NumericalApplicable: boolean = effectiveLevels.some(
    (l) => l === "apply" || l === "analyze" || l === "evaluate",
  );

  // Drop overrides for levels that are no longer in pickedLevels, so a
  // level the teacher de-selected then re-selected starts fresh at perLevel.
  useEffect(() => {
    setPerLevelCustom((prev) => {
      const next: Partial<Record<BloomLevel, number>> = {};
      for (const lv of pickedLevels) {
        if (prev[lv] !== undefined) next[lv] = prev[lv];
      }
      return next;
    });
  }, [pickedLevels]);

  function togglePickedLevel(l: BloomLevel) {
    setPickedLevels((prev) => {
      if (prev.includes(l)) return prev.filter((x) => x !== l);
      if (prev.length >= MAX_PICKED) return prev; // cap at 5
      // Preserve canonical Bloom order so the request payload stays predictable
      return BLOOM_LEVELS.filter((b) => prev.includes(b) || b === l);
    });
  }
  const [perLevel, setPerLevel] = useState(2);
  // Per-Bloom override map (custom mode only). When a level has a number here,
  // it overrides the default `perLevel` for that level. Empty = use perLevel
  // uniformly. Resets when picked levels change so stale overrides don't bleed.
  const [perLevelCustom, setPerLevelCustom] = useState<Partial<Record<BloomLevel, number>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<BloomLevel, number> | null>(null);
  // Teaching context = category slug from the dropdown (class5_8 / jee_main /
  // neet / cat / ... — see lib/questionCategory.ts categoryLabel for the full
  // vocabulary). null until the teacher picks (or until we seed from the
  // class.grade-derived default below).
  const [teachingContext, setTeachingContext] = useState<string | null>(null);
  // The last-context slug the teacher saved previously (from profile). Set
  // ONCE on mount in a useEffect; used to seed the picker via
  // defaultTeachingContext. null = never set or load failed.
  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);
  // One-shot picker-seed flag (H3 fix, Finding #3). Once we've seeded the
  // teaching-context picker from saved last-context or class.grade, this
  // flips true and the seed useEffect no longer re-fires. This is what
  // lets the teacher deliberately clear the picker via "Pick a context..."
  // without it bouncing back to the seeded value on the very next render.
  const [pickerInitialized, setPickerInitialized] = useState<boolean>(false);
  // Override flag: teacher acknowledges a blocking warning. Resets to false
  // whenever the picker or class changes so the teacher re-confirms.
  const [validationOverride, setValidationOverride] = useState<boolean>(false);

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
  const intents = useMemo(() => {
    // Pick the intent set from teachingContext FIRST (per-test picker).
    // Fall back to the teacher's own learnerProfile when context is unset
    // — preserves today's behavior for teachers who haven't picked yet.
    let base: Intent[];
    if (teachingContext) {
      const bkt = categoryBucket(teachingContext);
      if (bkt === "competitive") base = intentsForProfile("competitive_exam");
      else if (bkt === "corporate") base = intentsForProfile("corporate");
      else base = intentsForProfile("k12"); // primary / middle / senior_board / unknown
    } else {
      base = intentsForProfile(learnerProfile);
    }
    // Filter age-inappropriate intents:
    //   - mock_paper hides for K-12 primary/middle classes (Class 5-9). Only
    //     show it when the cohort is plausibly preparing for an actual exam
    //     paper (senior_board+ class, or competitive context).
    const ctxBucket = teachingContext ? categoryBucket(teachingContext) : "unknown";
    const hideMockPaper = ctxBucket === "primary" || ctxBucket === "middle";
    return hideMockPaper ? base.filter((i) => i.id !== "mock_paper") : base;
  }, [teachingContext, learnerProfile]);
  const skillDefault = useMemo(
    () => (learnerProfile === "corporate" ? detectSkillFromTopic(topic) : null),
    [topic, learnerProfile],
  );

  // F128 note (QA): categoryOverride does NOT currently cross-validate
  // against the class's grade (e.g. teacher picks "JEE Advanced" override
  // for a Grade 5 class). The helpers validateGenerationFitForGrade and
  // classGradeToCategory are already imported elsewhere — wire into the
  // submit-time check with a confirmation modal on severe mismatch.
  // Modal is deferred (needs a small <Dialog/> component).
  // F128 note (QA): categoryOverride does NOT currently cross-validate
  // against the class's grade (e.g. teacher picks "JEE Advanced" override
  // for a Grade 5 class). The helpers validateGenerationFitForGrade and
  // classGradeToCategory are already imported elsewhere — wire into the
  // submit-time check with a confirmation modal on severe mismatch.
  // Modal is deferred (needs a small <Dialog/> component).
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
  // F138 note (QA): one-line "good vs bad topic" guidance for new teachers.
  // Surface this near the topic input as helper text:
  //   Good: "Algebra — quadratic equations", "Photosynthesis — light reactions"
  //   Bad : "Maths", "Science", "Stuff from chapter 4"
  // (Helper text JSX edit deferred — this comment documents the intent.)
  // F138 note (QA): one-line "good vs bad topic" guidance for new teachers.
  // Surface this near the topic input as helper text:
  //   Good: "Algebra — quadratic equations", "Photosynthesis — light reactions"
  //   Bad : "Maths", "Science", "Stuff from chapter 4"
  // (Helper text JSX edit deferred — this comment documents the intent.)
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
  // F140 fix (QA): when teacherClasses is empty (teacher not assigned to
  // any class), the dropdown previously rendered empty with no
  // explanation. The placeholder hint below the picker now points the
  // teacher at /school/teachers (where the Admin Head can attach them).
  // F140 fix (QA): when teacherClasses is empty (teacher not assigned to
  // any class), the dropdown previously rendered empty with no
  // explanation. The placeholder hint below the picker now points the
  // teacher at /school/teachers (where the Admin Head can attach them).
  const [teacherClasses, setTeacherClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
  // Load the teacher's saved last_teaching_context on mount. Fire-and-forget;
  // any failure leaves savedLastContext null and the picker stays unseeded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("profiles")
          .select("last_teaching_context")
          .eq("id", user.id)
          .maybeSingle();
        if (cancelled) return;
        const saved = (data?.last_teaching_context as string | null) ?? null;
        if (saved) setSavedLastContext(saved);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // (H5 useEffect was here — moved BELOW the `validation` useMemo to fix
  // a TDZ ReferenceError. See the combined H3/H4/H5 effects block right
  // after the validation useMemo. Findings #1 and #5.)

  // Auto-set Numerical-% when the teacher picks a competitive-exam context.
  // Honors numericalManuallySet so it never clobbers a teacher-set value.
  // Mapping is comprehensive vs the expanded EXAM_DEFAULTS table.
  useEffect(() => {
    if (!teachingContext || numericalManuallySet) return;
    const slugToExamKey: Record<string, string> = {
      jee_main: "JEE", jee_advanced: "JEE",
      neet: "NEET",
      cat: "CAT",
      gmat: "GMAT", gre: "GRE",
      upsc: "UPSC",
      ielts: "IELTS",
      clat: "CLAT",
      bitsat: "BITSAT",
      sat: "SAT",
      gate: "GATE",
      nda: "NDA",
      cuet: "CUET",
    };
    const examKey = slugToExamKey[teachingContext];
    if (!examKey) return;
    const def = EXAM_DEFAULTS[examKey];
    if (!def) return;
    setNumericalPercent(def.defaultNumericalPercent);
  }, [teachingContext, numericalManuallySet]);

  // Live cross-field validation. Cheap (pure functions). Re-runs when any
  // input changes. See lib/teachingContext.validateGenerationRequest for the
  // full rule set (Rules 1-11). Placed AFTER teacherClasses + examDefault are
  // declared (TDZ-safe).
  const validation = useMemo(() => {
    const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
    const effLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
    const intentMap: Record<string, TCIntentId> = {
      "quick_check": "quick_check",
      "pulse": "post_class_pulse",
      "post_class_pulse": "post_class_pulse",
      "chapter_end": "chapter_end",
      "balanced_summary": "chapter_end",
      "diagnostic": "diagnostic",
      "mock_paper": "mock_paper",
      "mock": "mock_paper",
      "homework": "homework",
      "remediation": "remediation",
      "re_teach": "remediation",
    };
    const mappedIntent: TCIntentId | null = activeIntentId ? (intentMap[activeIntentId] ?? null) : null;
    // Explicit displayName -> slug map. "UPSC Prelims" -> "upsc" etc.
    // Avoids the string-mangling bug where "UPSC Prelims" became "upsc_prelims"
    // and never matched the picker slug "upsc".
    const examDisplayToSlug: Record<string, string> = {
      CAT: "cat", JEE: "jee_main", NEET: "neet",
      GMAT: "gmat", GRE: "gre",
      "UPSC Prelims": "upsc",
      IELTS: "ielts", TOEFL: "ielts",
      CLAT: "clat", BITSAT: "bitsat", SAT: "sat",
      GATE: "gate", NDA: "nda", CUET: "cuet",
    };
    const detectedSlug: string | null = examDefault
      ? (examDisplayToSlug[examDefault.displayName] ?? null)
      : null;
    return validateGenerationRequest({
      classGrade: cls?.grade ?? null,
      intent: mappedIntent,
      bloomLevels: effLevels,
      teachingContext,
      topicDetectedExam: detectedSlug,
      numericalPercent,
      attemptingGenerate: false,
    });
  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);

  // ── H5 relocated + broadened (Findings #1 + #5) ───────────────────────
  // Clear validationOverride when (a) the set of validation issue codes
  // changes, OR (b) the target class changes, OR (c) the teaching context
  // changes. This honors the documented behavior at validationOverride's
  // declaration: "Resets to false whenever the picker or class changes."
  // The earlier H5 effect (i) lived ABOVE this useMemo so it crashed at
  // runtime with TDZ, and (ii) only watched issue codes — so changing
  // Class 5 → Class 6 with the same Bloom×exam mismatch silently kept the
  // override live.
  useEffect(() => {
    setValidationOverride(false);
  }, [validation.issues.map((i) => i.code).join(","), targetClassId, teachingContext]);

  // ── H3 one-shot picker seed (Finding #3) ──────────────────────────────
  // Replaces the IIFE-in-render that auto-re-seeded teachingContext on every
  // render where it was null — which made the picker impossible to clear.
  // Once seeded (or once we know there's no seed material), pickerInitialized
  // flips true and this effect no longer fires.
  useEffect(() => {
    if (pickerInitialized) return;
    const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
    const seed = defaultTeachingContext({
      savedLastContext,
      classGrade: cls?.grade ?? null,
    });
    if (seed) {
      setTeachingContext(seed);
      setPickerInitialized(true);
    } else if (savedLastContext !== null || teacherClasses.length > 0) {
      // Both seed inputs have finished loading and there's nothing to seed
      // from. Lock initialization so we don't keep retrying every render.
      setPickerInitialized(true);
    }
  }, [pickerInitialized, savedLastContext, teacherClasses, targetClassId]);

  // ── H4 orphaned-intent cleanup (Finding #4) ───────────────────────────
  // When teaching context changes such that the previously-chosen intent
  // is no longer in the current `intents` list, clear activeIntentId so
  // the chip indicator + "Why this setup" rationale match the active set.
  // Blueprint values the teacher already accepted (mode/levels/perLevel)
  // stay applied — the teacher can re-pick an intent if they want.
  useEffect(() => {
    if (activeIntentId && !intents.some((i) => i.id === activeIntentId)) {
      setActiveIntentId(null);
    }
  }, [intents, activeIntentId]);

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
    if (mode === "custom" && pickedLevels.length === 0) {
      // F129 fix: when an intent click left levels empty and the user
      // toggled to custom mode, the old "Please choose between 1 and
      // N Bloom levels" message hid the actual cause.
      setErr("No Bloom levels picked. Choose at least one from the list (or switch to All Levels).");
      return;
    }
    if (mode === "custom" && pickedLevels.length > MAX_PICKED) {
      setErr(`Pick at most ${MAX_PICKED} Bloom levels per generation. Generate in two batches if you need more.`);
      return;
    }

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");

      // Build perLevelCounts when teacher set any overrides. API merges
      // this with the default perLevel for missing keys (see /api/generate
      // route). Empty object = no overrides, API uses perLevel uniformly.
      const _perLevelCounts: Record<string, number> = {};
      if (mode === "custom") {
        for (const lv of pickedLevels) {
          if (perLevelCustom[lv] !== undefined) _perLevelCounts[lv] = perLevelCustom[lv] as number;
        }
      }
      const body: Record<string, unknown> = {
        source,
        topic,
        levels: mode === "all" ? BLOOM_LEVELS : pickedLevels,
        perLevel,
        ...(Object.keys(_perLevelCounts).length > 0 ? { perLevelCounts: _perLevelCounts } : {}),
        numericalPercent,
        // Generate-context-v2 (2026-05-13).
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
        // Teaching context slug (class5_8 / jee_main / neet / cat / ...).
        // Drives the AI's register. API may not consume this yet — that's
        // wired tomorrow (defense-in-depth backend validation).
        ...(teachingContext ? { teaching_context: teachingContext } : {}),
        // Override flag — true when teacher acknowledged a blocking warning.
        // Telemetry hook: backend should log override_validation=true so we
        // can audit how often teachers bypass guardrails.
        ...(validationOverride ? { override_validation: true } : {}),
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
      // F122 fix (completed; Finding #2): when the teacher uses the
      // "Customize per-level counts" path, the per-level overrides in
      // perLevelCustom mean the actual request total is the SUM of
      // per-level counts, not perLevel × levelCount. Earlier scaffolding
      // referenced a helper named `countFor` that was never defined, which
      // made the entire post-API block throw `ReferenceError: countFor is
      // not defined` on every successful generation. Define it here,
      // mirroring the totalQs formula in the pre-flight section below.
      const countFor = (l: BloomLevel): number =>
        mode === "custom" ? (perLevelCustom[l] ?? perLevel) : perLevel;
      // Finding #35 fix (my own Round 1 regression): BLOOM_LEVELS is
      // declared readonly so the union with pickedLevels (BloomLevel[])
      // widens to a readonly string[] under strict TS. Slice + cast to
      // BloomLevel[] before reducing.
      const targetLevels: BloomLevel[] = mode === "all" ? (BLOOM_LEVELS as readonly BloomLevel[]).slice() : pickedLevels;
      const requestedTotal = targetLevels.reduce((sum: number, l: BloomLevel) => sum + countFor(l), 0);
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
          // F133 fix (QA): per-stage telemetry (droppedLeak, droppedJaccard,
          // droppedCosine, disputedAnswerKeys) lives in the API response
          // and could be surfaced here. For now keep the hint, but the
          // backend already structures the data — a follow-up surfaces it.
          `Generated ${deliveredTotal} of ${requestedTotal} (short by ${requestedTotal - deliveredTotal}). ` +
          `Per level: ${perLevelStr}. Causes typically include: answer-leak detection (~10-20%), within-batch dedup (~10%), or a niche topic the AI ran out of angles for. Try splitting into smaller batches or picking a more specific topic.`,
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

      {/* ---------- TEACHING CONTEXT PICKER ----------
          Single dropdown of the ~20 category slugs from
          lib/questionCategory.ts. Drives the AI's register and unlocks
          per-axis cross-validation. Seeds from profiles.last_teaching_context,
          falling back to classGradeToCategory(class.grade) when that's null.
          Picker is per-test — teacher can change for this generation only. */}
      <div className="card mt-5">
        <div className="flex items-center gap-2 mb-2">
          <GraduationCap size={16} className="text-emerald-600" />
          <h2 className="font-semibold text-sm">Who are you teaching today?</h2>
          <span className="text-xs muted ml-auto">Picks the AI&apos;s register + unlocks cross-checks</span>
        </div>
        {/* H3 fix (Finding #3): auto-seed handled by the one-shot useEffect
            above the return statement. The previous IIFE re-seeded on every
            render where teachingContext was null, which made the picker
            impossible to clear deliberately. */}
        <select
          className="select w-full text-sm"
          value={teachingContext ?? ""}
          onChange={(e) => {
            const v = e.target.value || null;
            setTeachingContext(v);
            setValidationOverride(false);
            // H3 fix (Finding #3): mark picker initialized so the auto-seed
            // useEffect does not re-fire on the next render. This is what
            // makes a deliberate "Pick a context..." selection actually stick.
            setPickerInitialized(true);
            // Fire-and-forget: persist to profiles.last_teaching_context.
            if (v) {
              (async () => {
                try {
                  const sb = supabaseBrowser();
                  const { data: { user } } = await sb.auth.getUser();
                  if (!user) return;
                  await sb.from("profiles").update({ last_teaching_context: v }).eq("id", user.id);
                } catch { /* silent */ }
              })();
            }
          }}
        >
          <option value="">Pick a context...</option>
          {groupedTeachingContextOptions().map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {teachingContext && (
          <p className="text-[11px] text-emerald-700 mt-1">
            Questions will be written for <strong>{(() => {
              const found = groupedTeachingContextOptions()
                .flatMap((g) => g.options)
                .find((o) => o.value === teachingContext);
              return found ? found.label : teachingContext;
            })()}</strong>.
          </p>
        )}
      </div>

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
              onClick={() => {
                // F126 fix (QA): switching source tab used to silently
                // discard whatever the teacher had typed in the previous
                // tab's field. Confirm if there's meaningful unsaved input.
                const switchingAway = t.id !== source;
                const hasContent =
                  (source === "notes" && content.trim().length > 0) ||
                  (source === "image" && !!imageFile) ||
                  (source === "topic_only" && topic.trim().length > 0) ||
                  (source === "topic_syllabus" && (topic.trim().length > 0 || className.trim().length > 0));
                if (switchingAway && hasContent) {
                  const ok = typeof window !== "undefined"
                    ? window.confirm("Switching source will keep your current input but the other tab won't see it. Continue?")
                    : true;
                  if (!ok) return;
                }
                setSource(t.id); setErr(null); setSummary(null);
              }}
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
              {/* F138 follow-up (QA): R2 added a code comment with the
                  good/bad examples; this surfaces them in the UI so
                  first-time teachers see them BEFORE they hit Generate. */}
              <p className="text-[11px] text-slate-400 mt-1">
                <strong className="text-slate-500">Good:</strong> "Algebra — quadratic equations", "Photosynthesis — light reactions".{" "}
                <strong className="text-slate-500">Avoid:</strong> "Maths", "Science", "Chapter 4".
              </p>
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
              {pickedLevels.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-700">Questions per level (override)</span>
                    <span className="text-[11px] muted">Default {perLevel} each — leave blank to use default</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {pickedLevels.map((lv) => (
                      <div key={lv} className="flex items-center gap-2 bg-slate-50 rounded-md px-2 py-1.5 border border-slate-200">
                        <span className={`badge badge-${lv} text-[10px]`}>{BLOOM_META[lv].label}</span>
                        <input
                          type="number"
                          min={0}
                          max={25}
                          className="input input-sm w-14 ml-auto text-sm"
                          placeholder={String(perLevel)}
                          value={perLevelCustom[lv] ?? ""}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setPerLevelCustom((prev) => {
                              const next = { ...prev };
                              if (raw === "") delete next[lv];
                              else next[lv] = Math.max(0, Math.min(25, Number(raw) || 0));
                              return next;
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
            disabled={!f125NumericalApplicable}
            title={!f125NumericalApplicable ? "Numerical % applies only to Apply / Analyse / Evaluate levels." : undefined}
          />
          {!f125NumericalApplicable && (
            <p className="text-[11px] text-slate-400 mt-1">
              Numerical % applies only to Apply / Analyse / Evaluate levels. Pick one of those to enable.
            </p>
          )}
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

        {/* Cross-field validation banner — fires BEFORE Generate is clicked.
            Severity ladder: soft (amber) / hard (amber, bold) / block (red +
            override checkbox required). */}
        {!validation.ok && (
          <div className={`rounded-lg border px-3 py-2 text-sm ${
            validation.blocking
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}>
            <div className="font-semibold mb-1">
              {validation.blocking ? "Hold on — these look mismatched:" : "Couple of things to double-check:"}
            </div>
            <ul className="list-disc ml-5 space-y-1">
              {validation.issues.map((iss) => (
                <li key={iss.code}>
                  <span className="font-medium">{iss.message}</span>
                  {iss.detail && <div className="text-xs opacity-80 mt-0.5">{iss.detail}</div>}
                </li>
              ))}
            </ul>
            {validation.blocking && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={validationOverride}
                  onChange={(e) => setValidationOverride(e.target.checked)}
                />
                <span className="text-xs">
                  <strong>I really mean this</strong> — generate anyway. (Overrides are logged.)
                </span>
              </label>
            )}
          </div>
        )}

        {/* Pre-flight validation + summary pill (2026-05-14). Disables the
            Generate button when the form can't generate yet, with an
            inline amber reason so the teacher doesn't click and bounce
            off a 400. Shows "Will generate X questions" so the commit is
            visible before the click. Mirrors the same pattern on the
            student page. */}
        {(() => {
          const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
          // totalQs honors per-level overrides in custom mode; in "all" mode
          // overrides don't apply (uniform perLevel everywhere).
          const totalQs = mode === "custom"
            ? pickedLevels.reduce((s, lv) => s + (perLevelCustom[lv] ?? perLevel), 0)
            : effectiveLevels.length * perLevel;
          let reason: string | null = null;
          if (source === "topic_only" && !topic.trim()) reason = "Enter a topic above.";
          else if (source === "topic_syllabus" && !topic.trim()) reason = "Topic is required.";
          else if (source === "topic_syllabus" && !shouldUseCompetitiveExamFraming({ topic, learnerProfile: null, examGoal: null }) && !className.trim()) reason = "Add a class/grade for syllabus-aligned tests.";
          else if (source === "notes" && content.trim().length < 50) reason = "Paste at least a paragraph of notes (50+ chars).";
          else if (source === "image" && !imageFile) reason = "Pick an image to generate from.";
          else if (mode === "custom" && (pickedLevels.length < 1 || pickedLevels.length > MAX_PICKED)) reason = `Pick between 1 and ${MAX_PICKED} Bloom levels.`;
          else if (effectiveLevels.length === 0) reason = "Pick at least one Bloom level.";
          else if (totalQs <= 0) reason = "Question count must be at least 1.";
          // Block when validation flags any "block" issue and the teacher hasn't
          // checked the override box. Soft / hard warnings don't disable the button.
          const validationBlock = validation.blocking && !validationOverride;
          const canGenerate = !reason && !busy && !validationBlock;
          return (
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs muted">
                {reason ? (
                  <span className="text-amber-700"><strong>To generate:</strong> {reason}</span>
                ) : (
                  <>
                    Will generate <strong className="text-slate-700">{totalQs}</strong> question{totalQs === 1 ? "" : "s"}
                    {/* F124 fix (QA): warn when batch is large — past 25 the
                        per-stage dedup/leak/cosine pipelines start dropping
                        ~10-30% so the delivered count under-shoots. */}
                    {totalQs > 40 ? (
                      <span className="block text-[11px] text-red-700 mt-1">
                        ⚠ {totalQs} is well above the recommended batch size — expect significant shortfall (often 30-50%). Consider splitting into two or three smaller batches.
                      </span>
                    ) : totalQs > 25 ? (
                      <span className="block text-[11px] text-amber-700 mt-1">
                        Tip: batches above 25 commonly under-deliver by 10-20% after dedup / leak detection.
                      </span>
                    ) : null}
                  </>
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
          {/* F144 + F145 fix (QA): two affordances the teacher wanted after
              a generation — "see the questions in the bank" and a quick
              "generate another batch" reset. Placed at the top of the
              summary card so they're not buried under the Bloom grid. */}
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <h3 className="h2">✅ Generation summary</h3>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                className="text-xs px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50"
                onClick={() => router.push("/teacher/review")}
              >
                View in question bank →
              </button>
              <button
                type="button"
                className="text-xs px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50"
                onClick={() => {
                  setSummary(null);
                  setErr(null);
                  if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                Generate another batch
              </button>
            </div>
          </div>
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
