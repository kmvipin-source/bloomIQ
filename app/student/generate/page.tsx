"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { BLOOM_LEVELS, BLOOM_META, recommendedQuizMinutes, type BloomLevel } from "@/lib/bloom";
import { Sparkles, FileText, Image as ImageIcon, GraduationCap, Tag, Play, ScrollText } from "lucide-react";
// LearnerProfilePrompt (the inline "K-12 / Competitive exam / Professional"
// pill that used to live on this page) has been removed. learner_profile is
// now auto-derived from profile.exam_goal at goal-pick time — single capture
// point in StudentGoalPicker. We still need the LearnerProfile TYPE here for
// the topic-placeholder + skill-detection logic below, so we import the type
// only (no component import).
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";
import CurrentGoalChip from "@/components/CurrentGoalChip";
import { detectSkillFromTopic } from "@/lib/skillDetectors";
import MarkingSchemePicker from "@/components/MarkingSchemePicker";
import type { MarkingScheme } from "@/lib/scoring";
import { suggestPresetForGoal, type ScoringPresetKey } from "@/lib/scoringPresets";
import { suggestedTopics, placeholderTopic } from "@/lib/topicSuggestions";
import { classifyQuizForRankPrediction } from "@/lib/rankPredictorEligibility";
import { shouldUseCompetitiveExamFraming } from "@/lib/examDetectors";
import GenerateContextChips, { type GenerateContext } from "@/components/GenerateContextChips";
// 2026-05-13 evening: audience-level is now fully optional and starts as
// null. No need to derive a profile-driven default — the GenerateContextChips
// component handles its own state. Old defaultAudienceLevelFor /
// buildLearningContext imports removed.

type Source = "topic_only" | "topic_syllabus" | "notes" | "image" | "past_paper";

// =============================================================================
// Client-side competitive-exam detector (mirror of backend in
// app/api/student/quick-test/route.ts). Used to auto-set the numerical %
// slider with a sensible default the moment the user types a known exam name.
// Each entry includes:
//   - displayName: shown in the explainer banner
//   - defaultNumericalPercent: app-suggested numerical %
//   - rationale: shown next to the slider so the student knows WHY we set it
// User can still drag the slider — we just stop touching it after they do.
// =============================================================================
type ExamDefault = {
  displayName: string;
  defaultNumericalPercent: number;
  rationale: string;
  // Bloom levels the actual exam paper genuinely contains. The UI warns
  // when a user picks a level outside this list — and the backend filters
  // them anyway, so generation stays honest.
  supportedBloomLevels: BloomLevel[];
};
const EXAM_NUMERICAL_DEFAULTS: Record<string, ExamDefault> = {
  CAT:   { displayName: "CAT",            defaultNumericalPercent: 35, rationale: "Quantitative Aptitude is roughly one-third of the paper.",                                supportedBloomLevels: ["apply", "analyze", "evaluate"] },
  JEE:   { displayName: "JEE",            defaultNumericalPercent: 70, rationale: "Physics + Math + parts of Chemistry are heavily numerical.",                              supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"] },
  NEET:  { displayName: "NEET",           defaultNumericalPercent: 30, rationale: "Physics + parts of Chemistry are numerical; Biology is mostly conceptual.",               supportedBloomLevels: ["remember", "understand", "apply", "analyze"] },
  GMAT:  { displayName: "GMAT",           defaultNumericalPercent: 40, rationale: "Quant + Data Insights are numerical; Verbal is not.",                                     supportedBloomLevels: ["apply", "analyze", "evaluate"] },
  GRE:   { displayName: "GRE",            defaultNumericalPercent: 50, rationale: "Quantitative Reasoning is half the test.",                                                supportedBloomLevels: ["understand", "apply", "analyze", "evaluate"] },
  UPSC:  { displayName: "UPSC Prelims",   defaultNumericalPercent: 10, rationale: "GS is conceptual; CSAT has some quant + reasoning.",                                      supportedBloomLevels: ["remember", "understand", "apply", "analyze"] },
  IELTS: { displayName: "IELTS",          defaultNumericalPercent: 0,  rationale: "Pure language test — no numerical content.",                                              supportedBloomLevels: ["understand", "apply", "analyze"] },
  TOEFL: { displayName: "TOEFL",          defaultNumericalPercent: 0,  rationale: "Pure language test — no numerical content.",                                              supportedBloomLevels: ["understand", "apply", "analyze"] },
  CLAT:  { displayName: "CLAT",           defaultNumericalPercent: 10, rationale: "Quantitative Techniques is one of five sections.",                                        supportedBloomLevels: ["remember", "understand", "apply", "analyze"] },
  BITSAT:{ displayName: "BITSAT",         defaultNumericalPercent: 70, rationale: "Physics + Chemistry + Math dominate; English/Logical small.",                             supportedBloomLevels: ["understand", "apply", "analyze"] },
  SAT:   { displayName: "SAT",            defaultNumericalPercent: 50, rationale: "Math is half the SAT; Reading & Writing the other half.",                                supportedBloomLevels: ["apply", "analyze"] },
  GATE:  { displayName: "GATE",           defaultNumericalPercent: 70, rationale: "Engineering Mathematics + subject section are highly numerical.",                         supportedBloomLevels: ["apply", "analyze", "evaluate"] },
  NDA:   { displayName: "NDA",            defaultNumericalPercent: 50, rationale: "Mathematics is half; General Ability the other half.",                                    supportedBloomLevels: ["remember", "understand", "apply"] },
  CUET:  { displayName: "CUET",           defaultNumericalPercent: 30, rationale: "Mix varies by chosen subjects; quant is part of General Test.",                            supportedBloomLevels: ["remember", "understand", "apply"] },
};

function detectExamDefault(topic: string): ExamDefault | null {
  if (!topic) return null;
  const tokens = topic.toUpperCase().split(/[\s,;.\-/_()]+/).filter(Boolean);
  for (const t of tokens) {
    if (EXAM_NUMERICAL_DEFAULTS[t]) return EXAM_NUMERICAL_DEFAULTS[t];
  }
  return null;
}

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
  const searchParams = useSearchParams();
  // Phase 4 (2026-05-13): "Generate more on..." chips on the results page
  // deep-link here with ?topic=X&prefill_chip=Y. Pre-fill the topic input
  // and seed the additional_focus hint so the user lands ready-to-go.
  // Read once on mount; subsequent param changes (rare) are ignored.
  const [prefillChip, setPrefillChip] = useState<string | null>(null);
  useEffect(() => {
    const t = searchParams?.get("topic") || "";
    const chip = searchParams?.get("prefill_chip") || "";
    if (t) setTopic(t);
    if (chip) setPrefillChip(chip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default to "topic_only" so the form is immediately usable; past_paper stays
  // the first (highlighted) tile so it's visually featured.
  const [source, setSource] = useState<Source>("topic_only");
  const [topic, setTopic] = useState("");
  // Generate-context-v2 (2026-05-13): audience level + sub-topic chips +
  // optional focus textbox. The component owns its UI state; we just keep
  // the latest payload here so it spreads into the request body.
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
  // Per-test marking scheme (migration 76). NULL = legacy +1/0/0 default.
  // Picker emits a new value on every change. We send it to the
  // /api/student/quick-test endpoint, which persists onto the quiz.
  const [markingScheme, setMarkingScheme] = useState<MarkingScheme | null>(null);
  // Auto-suggestion based on the student's profile.exam_goal. When the
  // student has goal "jee_main", the picker shows a one-line "Switch to
  // JEE Main" banner with a one-click apply button. Default PRACTICE
  // until the student manually picks.
  const [suggestedPreset, setSuggestedPreset] = useState<ScoringPresetKey>("PRACTICE");
  // Same pattern for numerical %: app-suggested when topic matches an exam,
  // but stop overriding the moment the user drags the slider.
  const [numericalManuallySet, setNumericalManuallySet] = useState(false);
  // Mode toggle: "Pick how many" (existing flow) vs "Pick how long" (new flow
  // where the student types target minutes and we choose the question count).
  const [planMode, setPlanMode] = useState<"by_count" | "by_time">("by_count");
  // Target minutes for "Pick how long" mode. Defaults to 20 — a reasonable
  // practice-test length for an indie student.
  const [targetMinutes, setTargetMinutes] = useState(20);

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

  // Fetch the student's exam_goal once to auto-suggest a marking-scheme
  // preset. e.g. exam_goal === "jee_main" → suggestPresetForGoal returns
  // "JEE_MAIN" → the picker renders a one-line "Switch to JEE Main"
  // banner. The student still has to click to apply — we don't change
  // their default behind their back.
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        // Fetch both fields in one round-trip. exam_goal drives the
        // marking-scheme suggestion banner; learner_profile drives the
        // topic-placeholder / skill-detection branches further down.
        // learner_profile is auto-derived from exam_goal at goal-pick
        // time (see StudentGoalPicker) so for users who picked their
        // goal post-consolidation, the two are guaranteed in sync.
        // For legacy users who chose K-12/competitive/corporate before
        // consolidation, the stored value is honoured as-is.
        const { data: prof } = await sb
          .from("profiles")
          .select("exam_goal, learner_profile, last_marking_scheme")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as {
          exam_goal: string | null;
          learner_profile: string | null;
          last_marking_scheme: unknown | null;
        } | null;
        setSuggestedPreset(suggestPresetForGoal(row?.exam_goal ?? null));
        if (row?.exam_goal) setExamGoal(row.exam_goal);
        const lp = row?.learner_profile;
        if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
          setLearnerProfile(lp);
        }
        // Derive default audience level from profile so the chip starts in
        // the right place — school student → Beginner, JEE/CAT/corporate
        // → Practitioner. The component lets the user override.
        // (audience-level default removed 2026-05-13 evening — chip is now optional)
        // Sticky marking scheme — if the user has picked a scheme on any
        // surface before, pre-fill this picker with it. NULL means
        // they've never picked → picker falls back to PRACTICE + the
        // goal-suggested banner ("Switch to CAT", etc.). See
        // migration 77 + lib/markingSchemeMemory.ts.
        if (row?.last_marking_scheme && typeof row.last_marking_scheme === "object") {
          setMarkingScheme(row.last_marking_scheme as MarkingScheme);
        }
      } catch { /* non-fatal — picker just shows no banner */ }
    })();
  }, []);

  // Detect competitive exam from topic and auto-suggest numerical %. Only
  // fires while numericalManuallySet is false — the student can always
  // override and we'll respect their choice from then on.
  const examDefault = useMemo(() => detectExamDefault(topic), [topic]);
  useEffect(() => {
    if (examDefault && !numericalManuallySet) {
      setNumericalPercent(examDefault.defaultNumericalPercent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examDefault]);

  // ---- Q2: Learner profile drives skill detection (corporate only) -
  // K-12 / competitive_exam students see the existing flow unchanged.
  // Corporate students additionally get tech-skill detection for
  // topics like "Java", "AWS", "JCL", "Kubernetes" etc.
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  // exam_goal (granular). Powers the goal-aware topic placeholders +
  // chips. Populated from profile in the useEffect above. Defaulting to
  // null means the placeholderTopic helper falls back to learner_profile,
  // which itself falls back to K-12 — same as before the goal-aware
  // pass on 2026-05-12, so legacy users see no regression.
  const [examGoal, setExamGoal] = useState<string | null>(null);

  // Competitive-exam framing decision (2026-05-14 evening, fixed).
  //
  // Previous implementation: only checked the topic text. That meant a JEE
  // student typing "Algebra" or "Calculus" — the most natural flow for an
  // engineering aspirant practising a specific topic — got the CBSE/ICSE
  // K-12 inputs because the topic alone has no JEE token. (Tester filed
  // this as "I select JEE exam, in class/grade it displays Class 8,9 — in
  // syllabus CBSE etc.".)
  //
  // New implementation: ALSO honour the student's profile signal. If their
  // learner_profile is "competitive_exam" or their exam_goal slug names a
  // competitive exam (jee_main, neet_prep, cat_prep, …) we use the
  // competitive-exam framing regardless of what they typed in the topic
  // field. Single source of truth: shouldUseCompetitiveExamFraming in
  // lib/examDetectors.ts — same helper the backend uses.
  const isCompetitiveExamTopic = useMemo(() => {
    return shouldUseCompetitiveExamFraming({
      topic,
      learnerProfile,
      examGoal,
    });
  }, [topic, learnerProfile, examGoal]);
  // Distinguish topic-detection from profile-detection so the banner can
  // say WHICH signal we used (helps the student understand why the inputs
  // disappeared even when they typed a generic topic like "Algebra").
  const compFramingReason = useMemo<"topic" | "profile" | null>(() => {
    if (!isCompetitiveExamTopic) return null;
    // Topic-detection (CAT/JEE/NEET in the topic text itself) is the more
    // specific signal — it wins for the banner even if profile also matches.
    const v = classifyQuizForRankPrediction({ topic, name: null, topicFamily: null });
    if (v.verdict === "matches_known_exam" || v.verdict === "competitive_exam_other") {
      return "topic";
    }
    return "profile";
  }, [topic, isCompetitiveExamTopic]);
  const skillDefault = useMemo(
    () => (learnerProfile === "corporate" ? detectSkillFromTopic(topic) : null),
    [topic, learnerProfile],
  );
  // ---- Profile-aware topic placeholders -------------------------
  // Same pattern as /teacher/generate. Adapts the example text the
  // student sees in topic fields based on their learner_profile.
  // is_school_student is INTENTIONALLY not consulted here — a
  // corporate trainee enrolled by their L&D logs in as a school
  // student in our schema, but their learner_profile is "corporate".
  // Goal-aware placeholders (2026-05-12 fix). Previously these three
  // functions only branched on learner_profile (3 buckets), which
  // collapses CAT, NEET, JEE, UPSC, Bank exams into the same
  // "competitive_exam" string — a CAT student would see "NEET Biology"
  // and vice versa. Now all three pull from suggestedTopics keyed off
  // the granular exam_goal, falling back to learner_profile, falling
  // back to K-12 generic. See lib/topicSuggestions.ts.
  function topicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }
  function syllabusTopicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }
  function topicOnlyPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }
  function subjectPlaceholder(): string {
    // Subject-list placeholder — a comma-separated example. Use the
    // first three goal-aware topic suggestions for every learner type.
    // (Previously corporate users were hardcoded to "AWS, Java, Mainframe"
    // regardless of their actual role; suggestedTopics now disambiguates
    // by exam_goal first, learner_profile second.)
    const tops = suggestedTopics(examGoal, learnerProfile).slice(0, 3);
    return `e.g. ${tops.join(", ").slice(0, 80)}`;
  }

  // "Pick how long" mode — derive a NON-UNIFORM per-level question count
  // from the student's target time. Each Bloom level takes a different
  // amount of time per question (Remember = 30s, Create = 180s), so a
  // 20-min test should naturally have more easy questions than hard ones.
  // Algorithm: divide usable time equally across selected levels, then
  // floor(slot / secsPerQ) for each level (min 1).
  const computedFromTime = useMemo(() => {
    if (planMode !== "by_time") return null;
    if (effectiveLevels.length === 0) return null;
    // Mirror lib/bloom.ts BLOOM_SECONDS_PER_QUESTION values. Keep in sync
    // if the canonical table is ever rebalanced.
    const SECS_PER_Q: Record<BloomLevel, number> = {
      remember: 30, understand: 60, apply: 90, analyze: 120, evaluate: 150, create: 180,
    };
    // Strip the 15% review buffer the recommendation adds, so a "20 min"
    // target produces ~20 min of actual question-solving time.
    const usableSec = (targetMinutes * 60) / 1.15;
    const slotSec = usableSec / effectiveLevels.length;
    const counts = {} as Record<BloomLevel, number>;
    for (const l of BLOOM_LEVELS) counts[l] = 0;
    for (const l of effectiveLevels) {
      counts[l] = Math.max(1, Math.floor(slotSec / SECS_PER_Q[l]));
    }
    const totalQ = effectiveLevels.reduce((s, l) => s + counts[l], 0);
    return { counts, totalQ };
  }, [planMode, effectiveLevels, targetMinutes]);

  // The perLevel sent to the API in by_count mode. by_time mode sends a
  // separate `perLevelCounts` map (handled below).
  const effectivePerLevel = perLevel;
  // The time the API receives. In by_count mode it's the (possibly overridden)
  // suggested limit; in by_time mode it IS the input.
  const effectiveTimeLimit = planMode === "by_time" ? targetMinutes : timeLimit;

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
    if (source === "topic_syllabus" && !topic.trim()) {
      return setErr("Topic is required.");
    }
    // Class/grade is only required when the topic isn't a competitive exam.
    // CAT/JEE/NEET/etc. don't have classes or boards — we drop the fields
    // entirely in that branch (see JSX below).
    if (source === "topic_syllabus" && !isCompetitiveExamTopic && !className.trim()) {
      return setErr("Class/grade is required for a syllabus-aligned test.");
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
        perLevel: effectivePerLevel,
        timeLimit: effectiveTimeLimit,
        numericalPercent,
        // Per-test marking scheme — picked by the student via the
        // MarkingSchemePicker. NULL means "use legacy +1/0/0 default."
        // /api/student/quick-test persists this into quizzes.marking_scheme.
        markingScheme,
        // Generate-context-v2 (2026-05-13): audience level + sub-topic
        // chips + optional focus textbox. All optional; backend uses
        // sensible defaults if missing. See lib/audienceLevel,
        // lib/topicEnrichment.
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
      };
      // by_time mode produces non-uniform counts (Remember gets more than
      // Create for the same time). Send the full map; the API will use it
      // and ignore `perLevel` when present.
      if (planMode === "by_time" && computedFromTime) {
        body.perLevelCounts = computedFromTime.counts;
      }
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
      // Off-topic textbox guard (2026-05-13). If the server stripped an
      // unrelated focus, show the user WHY before the success toast.
      if (data.focus_warning) toast.error(data.focus_warning);
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
    // Past paper stays first (flagship exam-prep affordance for indie
    // students). Remaining four match the order on /teacher/generate:
    // syllabus → just-a-topic → notes → image.
    // Order picked deliberately for school students:
    //   curriculum-driven first, then quick topic, then notes — these are
    //   the dominant K-12 study patterns. Past paper sits 4th because
    //   most school students aren't doing exam prep on day one (the
    //   ones who ARE will recognize it instantly anyway). Image last.
    { id: "topic_syllabus", icon: <GraduationCap size={18} />,   label: "Topic + class + syllabus",desc: "Aligned to your curriculum" },
    { id: "topic_only",     icon: <Tag size={18} />,             label: "Just a topic",            desc: "Quick practice on any subject" },
    { id: "notes",          icon: <FileText size={18} />,        label: "From your notes",         desc: "Paste class notes or a chapter" },
    { id: "past_paper",     icon: <ScrollText size={18} />,      label: "Past question paper",     desc: "Upload last year’s exam — get questions in the same style", badge: "🎯 Exam prep" },
    { id: "image",          icon: <ImageIcon size={18} />,       label: "From an image",           desc: "Photo of a textbook page, diagram, or notes" },
  ];

  const totalQs = effectiveLevels.length * perLevel;

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="h1">New practice test</h1>
        {/* CurrentGoalChip — replaces the old inline LearnerProfilePrompt.
            Tap → /student/settings/goal (master change screen). */}
        <CurrentGoalChip />
      </div>

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
            <input className="input" placeholder={topicOnlyPlaceholder()}
                   value={topic} onChange={(e) => setTopic(e.target.value)} />
            <p className="text-xs muted mt-1">Questions are written from general knowledge of the topic.</p>
          </div>
        )}

        {source === "topic_syllabus" && (
          <>
            <div className={isCompetitiveExamTopic ? "" : "grid sm:grid-cols-2 gap-3"}>
              <div>
                <label className="label">Topic</label>
                <input className="input" placeholder={syllabusTopicPlaceholder()}
                       value={topic} onChange={(e) => setTopic(e.target.value)} />
              </div>
              {!isCompetitiveExamTopic && (
                <div>
                  <label className="label">Class / grade</label>
                  <input className="input" placeholder="e.g. Class 9 / Grade 9"
                         value={className} onChange={(e) => setClassName(e.target.value)} />
                </div>
              )}
            </div>
            {/* Class+syllabus fields don't apply for competitive exams (CAT /
                JEE / NEET / GMAT / GATE / UPSC / ...). The backend infers
                exam framing from the topic itself via learningContext. */}
            {!isCompetitiveExamTopic ? (
              <div>
                <label className="label">Syllabus / board <span className="muted text-xs">(optional)</span></label>
                <input className="input" placeholder="e.g. CBSE, ICSE, Cambridge IGCSE, NCERT Chapter 9"
                       value={syllabus} onChange={(e) => setSyllabus(e.target.value)} />
              </div>
            ) : (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                {compFramingReason === "profile" ? (
                  <>
                    <strong>Competitive-exam preparation detected from your goal.</strong>{" "}
                    Class and syllabus aren&apos;t needed — we&apos;ll generate questions in
                    the style of the exam paper itself. If you want K-12 syllabus framing
                    for this test instead, switch your goal in{" "}
                    <a href="/settings" className="underline font-semibold">Settings</a>.
                  </>
                ) : (
                  <>
                    <strong>Competitive-exam topic detected.</strong> Class and syllabus
                    aren&apos;t needed — we&apos;ll generate questions in the style of the
                    exam paper itself.
                  </>
                )}
              </p>
            )}
          </>
        )}

        {source === "notes" && (
          <>
            <div>
              <label className="label">Topic <span className="muted text-xs">(optional)</span></label>
              <input className="input" placeholder={topicPlaceholder()}
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
              <input className="input" placeholder={subjectPlaceholder()}
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
          {/* When the topic matches a known competitive exam, warn if any
              of the user's selected Bloom levels aren't actually tested
              by that exam. The backend filters them anyway — this surface
              just sets honest expectations BEFORE the request goes out. */}
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

        {/* Mode toggle — students/teachers pick whichever framing matches
            how they're thinking about the test. Both modes share Bloom
            level selection (above) and numerical % (below). */}
        <div>
          <label className="label">Set up your test</label>
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setPlanMode("by_count")}
              className={`px-3 py-1.5 text-sm font-semibold transition ${planMode === "by_count" ? "bg-emerald-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              Pick how many
            </button>
            <button
              type="button"
              onClick={() => setPlanMode("by_time")}
              className={`px-3 py-1.5 text-sm font-semibold transition ${planMode === "by_time" ? "bg-emerald-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              Pick how long
            </button>
          </div>
          <p className="text-xs muted mt-1">
            {planMode === "by_count"
              ? "Choose the question count and we'll suggest a time."
              : "Choose how long you have and we'll size the question count to fit."}
          </p>
        </div>

        {planMode === "by_count" ? (
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
                  Suggested: <strong className="text-slate-700">{recommendedMinutes} min</strong> for these {totalQs} question{totalQs === 1 ? "" : "s"} — derived from question complexity (Bloom-level mix). {timeLimit !== recommendedMinutes ? <>Your current limit of {timeLimit} min gives ~{Math.max(1, Math.round((timeLimit * 60) / Math.max(1, totalQs)))} sec/question.</> : <>That works out to ~{Math.max(1, Math.round((recommendedMinutes * 60) / Math.max(1, totalQs)))} sec/question.</>}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div>
            <label className="label">How long do you have?</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={180}
                className="input w-32"
                value={targetMinutes}
                onChange={(e) => setTargetMinutes(Math.max(5, Math.min(180, +e.target.value || 5)))}
              />
              <span className="text-sm text-slate-600">minutes</span>
            </div>
            {computedFromTime ? (
              <div className="text-xs muted mt-1 space-y-1">
                <p>
                  We&apos;ll size your test to about{" "}
                  <strong className="text-slate-700">{computedFromTime.totalQ} question{computedFromTime.totalQ === 1 ? "" : "s"}</strong>
                  {" "}across the {effectiveLevels.length} Bloom level{effectiveLevels.length === 1 ? "" : "s"} you picked. Easier levels get more questions because they take less time per question:
                </p>
                <p className="text-slate-600">
                  {effectiveLevels.map((l, i) => (
                    <span key={l}>
                      {i > 0 ? " · " : ""}
                      <strong className="text-slate-700">{computedFromTime.counts[l]}</strong> {BLOOM_META[l].label}
                    </span>
                  ))}
                </p>
              </div>
            ) : (
              <p className="text-xs muted mt-1">Pick at least one Bloom level above to see the question count.</p>
            )}
          </div>
        )}

        {/* Generate-context-v2 (2026-05-13): audience-level chip +
            auto-detected sub-topic chips + optional "Anything specific?"
            textbox. Component owns its own UI state; we just collect the
            payload via onChange. Topic-blank state: component renders but
            doesn't fetch sub-topic chips until topic is at least 3 chars. */}
        <GenerateContextChips
          topic={topic}
          onChange={setGenContext}
          disabled={busy}
          initialFocus={prefillChip ? `Focus on: ${prefillChip}` : undefined}
        />

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
          {examDefault && !numericalManuallySet ? (
            <p className="text-xs mt-1" style={{ color: "var(--brand-700, #047857)" }}>
              Set to <strong>{examDefault.defaultNumericalPercent}%</strong> to match {examDefault.displayName} — {examDefault.rationale} Drag the slider to override.
            </p>
          ) : examDefault && numericalManuallySet ? (
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
          ) : (
            <p className="text-xs muted mt-1">
              Target % of questions involving calculation or numbers. Auto-ignored for non-numerical topics (history, literature, etc.).
            </p>
          )}
        </div>

        {/* Marking scheme picker (migration 76). Default PRACTICE
            (+1 correct / 0 wrong) keeps practice tests friendly. Students
            preparing for JEE / NEET / CAT pick the matching preset to get
            negative-marks-aware scoring on raw_score / max_score; the
            separate negative-marks toggle lets them run "JEE-weighted but
            no penalty" diagnostics. suggestedPreset comes from the
            student's profile.exam_goal — picker shows a one-tap
            "Switch to <preset>" banner when goal-aware. */}
        <div>
          <label className="label">Marking scheme</label>
          <MarkingSchemePicker
            value={markingScheme}
            onChange={setMarkingScheme}
            suggested={suggestedPreset}
          />
        </div>

        {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
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
