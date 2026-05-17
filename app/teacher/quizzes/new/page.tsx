"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, isBloomLevel, recommendedQuizMinutes, type BloomLevel } from "@/lib/bloom";
import type { Question } from "@/lib/types";
import { generateQuizCode } from "@/lib/utils";
import BloomBadge from "@/components/BloomBadge";
import MarkingSchemePicker from "@/components/MarkingSchemePicker";
import type { MarkingScheme } from "@/lib/scoring";
import { suggestPresetForGoal, type ScoringPresetKey } from "@/lib/scoringPresets";
import {
  groupedTeachingContextOptions,
  defaultTeachingContext,
} from "@/lib/teachingContext";
import {
  validateGenerationFitForGrade,
  // Finding #36 fix (B.1): categoryLabel was imported here AND also re-aliased
  // from categoryLabelShared at line ~70, causing TS2440 (import conflicts
  // with local declaration). Dropped the direct import; the alias stays so
  // the rest of the file keeps working unchanged.
} from "@/lib/questionCategory";
import {
  categoryLabel as categoryLabelShared,
  NO_CATEGORY_LABEL,
  classGradeToCategory,
  classQuestionMismatchWarning,
} from "@/lib/questionCategory";
import {
  Search, Layers, Plus, Check, X, ChevronUp, ChevronDown,
  Trash2, Sparkles, Clock, Wand2, Lightbulb, Users,
} from "lucide-react";

type VariantCandidate = {
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  bloom_level: BloomLevel;
  topic: string | null;
  verified: boolean;
};

// --- Feature B (class-fit suggestion) types ---------------------------
// We fetch the teacher's class list once on mount, then call /api/teacher/
// class-fit any time the chosen class or selected question set changes.
type ClassOption = {
  id: string;
  name: string;
  grade?: string | null;
  section?: string | null;
  subject?: string | null;
  myRole?: "primary" | "co" | "acting";
  memberCount?: number;
};

type ClassFit = {
  matched: number;
  total: number;
  attempts: number;
  avg_score_pct: number | null;
};

const NO_TOPIC = "(no topic)";
const topicKey = (t: string | null | undefined) => (t && t.trim()) || NO_TOPIC;

// 2026-05-15 — category-label is now sourced from lib/questionCategory
// (alias preserved as `categoryLabel` so existing local references compile).
// The local definition used to live here; moved to lib/ so /teacher/review,
// /teacher/papers/new, and any future surface can share the same vocabulary.
const NO_CATEGORY = NO_CATEGORY_LABEL;
const categoryLabel = categoryLabelShared;

function ComposerInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [time, setTime] = useState(15);
  const [timeManuallySet, setTimeManuallySet] = useState(false);
  // Per-test marking scheme (migration 76). NULL means the legacy
  // +1/0/0 default — every quiz created before today has implicit NULL
  // and continues to grade identically. Picker emits a new value on
  // every keystroke; we persist to quizzes.marking_scheme on save.
  //
  // Sticky default (migration 77): on mount, fetch profile.last_marking_scheme
  // and pre-fill the picker with whatever the teacher last chose on any
  // surface. NULL → picker stays at PRACTICE default.
  const [markingScheme, setMarkingScheme] = useState<MarkingScheme | null>(null);
  // 2026-05-15 — goal-aware suggestion + age-appropriate validation moved to
  // the assemble flow. The teacher's exam_goal (teaching context) drives the
  // "Switch to <preset>" banner inside MarkingSchemePicker, and we surface a
  // warning if they apply negative-marking presets to a primary/middle-class
  // cohort (Class 5-8 / Class 9). Negative marking on a 12-year-old is
  // pedagogically harmful — the warning isn't a hard block, just informed
  // consent.
  const [teacherExamGoal, setTeacherExamGoal] = useState<string | null>(null);
  // Teaching context = which category this test is being composed for.
  // Same vocabulary as /teacher/generate (slug from lib/questionCategory).
  // Drives suggested marking-scheme preset + the class-vs-context banner.
  const [teachingContext, setTeachingContext] = useState<string | null>(null);
  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);
  // Override flag: teacher acknowledges a blocking class-vs-context mismatch
  // and proceeds with the assign anyway. Reset on every meaningful change.
  const [validationOverride, setValidationOverride] = useState<boolean>(false);
  const [suggestedPreset, setSuggestedPreset] = useState<ScoringPresetKey>("PRACTICE");
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data: prof } = await sb
          .from("profiles")
          .select("last_marking_scheme, exam_goal")
          .eq("id", user.id)
          .maybeSingle();
        const lms = (prof as { last_marking_scheme?: unknown } | null)?.last_marking_scheme;
        if (lms && typeof lms === "object") setMarkingScheme(lms as MarkingScheme);
        const goal = (prof as { exam_goal?: string | null } | null)?.exam_goal ?? null;
        setTeacherExamGoal(goal);
        setSuggestedPreset(suggestPresetForGoal(goal));
      } catch { /* silent — picker stays at PRACTICE default */ }
    })();
  }, []);

  /**
   * Age-appropriate marking validation. Returns a string warning if the
   * current marking scheme applies a negative penalty AND the teacher's
   * teaching context is primary/middle (Class 5-8 / Class 9). Returns null
   * when there is no concern. Pure function so it can be re-evaluated as
   * the picker changes.
   */
  function negativeMarkingWarning(ms: MarkingScheme | null, goal: string | null): string | null {
    if (!ms) return null;
    const penalty = Number((ms as { wrong?: number; negative?: number }).wrong ?? (ms as { negative?: number }).negative ?? 0);
    if (penalty >= 0) return null;
    const g = (goal || "").toLowerCase().trim();
    const primaryMiddle =
      g === "class5_8" || g === "class_5_8" ||
      g === "class_9" || g === "class9";
    if (!primaryMiddle) return null;
    return "Heads up: you have negative marking on for a Class 5-9 cohort. " +
           "For this age group, most teachers stick to positive-only scoring — " +
           "negative marking can discourage attempting questions and distort feedback. " +
           "Keep it only if you're explicitly training exam strategy.";
  }
  // Finding #38 fix (B.3): relocated above contextFit useMemo to fix TDZ.
  // These states were originally declared below line 270; the contextFit
  // useMemo at line ~149 reads them, which triggered TS2448/TS2454 under
  // strict TS once the CI gap closed in Round 5.
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");

  // Class-vs-context fit. Re-runs on class or picker change. Reuses the
  // existing validateGenerationFitForGrade helper from lib/questionCategory.
  const contextFit = useMemo(() => {
    const cls = classes.find((c) => c.id === targetClassId) || null;
    if (!cls?.grade || !teachingContext) return null;
    return validateGenerationFitForGrade(cls.grade, teachingContext);
  }, [classes, targetClassId, teachingContext]);


  const negMarkingWarn = useMemo(
    () => negativeMarkingWarning(markingScheme, teacherExamGoal),
    [markingScheme, teacherExamGoal],
  );

  const [bank, setBank] = useState<Question[]>([]);
  const [loadingBank, setLoadingBank] = useState(true);
  const [bloomFilter, setBloomFilter] = useState<BloomLevel | "all">("all");
  const [topicFilter, setTopicFilter] = useState<string>("all");
  // 2026-05-15 (migration 90) — category filter. "all" = no filter,
  // "_none" = show only rows with NULL category (legacy/untagged questions).
  // Anything else is an exam_goal slug ("jee_main", "class_10_boards", etc.)
  // matching the question_bank.category column written by /api/generate.
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // 2026-05-16 — auto-save draft to localStorage. Never lose work.
  const DRAFT_KEY = "zcoriq.composer.draft.v1";
  type DraftSnapshot = {
    selectedIds: string[];
    name: string;
    subject: string;
    time: number;
    targetClassId: string;
    savedAt: number;
  };
  const [draftRestored, setDraftRestored] = useState<DraftSnapshot | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Restore offer on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as DraftSnapshot;
      // Only offer drafts < 24h old, and only if non-empty.
      const ageMs = Date.now() - (d.savedAt || 0);
      if (ageMs < 24 * 60 * 60 * 1000 && Array.isArray(d.selectedIds) && d.selectedIds.length > 0) {
        setDraftRestored(d);
      }
    } catch { /* localStorage blocked or bad JSON — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function applyDraft(d: DraftSnapshot) {
    setSelectedIds(d.selectedIds || []);
    if (d.name) setName(d.name);
    if (d.subject) setSubject(d.subject);
    if (typeof d.time === "number" && d.time > 0) setTime(d.time);
    if (d.targetClassId) setTargetClassId(d.targetClassId);
    setDraftRestored(null);
  }
  // 2026-05-16 — recent-topic localStorage. Tracks the last 3 distinct
  // topics this teacher filtered on; surfaced as quick chips above the
  // Topics row.
  const RECENT_TOPICS_KEY = "zcoriq.composer.recentTopics.v1";
  const [recentTopics, setRecentTopics] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_TOPICS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) setRecentTopics(arr.filter((x) => typeof x === "string").slice(0, 3));
    } catch {}
  }, []);
  useEffect(() => {
    if (!topicFilter || topicFilter === "all") return;
    setRecentTopics((prev) => {
      const next = [topicFilter, ...prev.filter((t) => t !== topicFilter)].slice(0, 3);
      try { window.localStorage.setItem(RECENT_TOPICS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [topicFilter]);

  function discardDraft() {
    try { window.localStorage.removeItem(DRAFT_KEY); } catch {}
    setDraftRestored(null);
  }
  // Debounced autosave: writes the current composer state to
  // localStorage 600ms after the last change. No write while a draft
  // restore prompt is still showing (we'd clobber the saved one).
  useEffect(() => {
    if (draftRestored) return;
    const t = setTimeout(() => {
      try {
        if (selectedIds.length === 0 && !name && !subject && !targetClassId) {
          window.localStorage.removeItem(DRAFT_KEY);
          return;
        }
        const snap: DraftSnapshot = {
          selectedIds, name, subject, time, targetClassId,
          savedAt: Date.now(),
        };
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(snap));
        setLastSavedAt(Date.now());
      } catch { /* quota / blocked — ignore */ }
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, name, subject, time, targetClassId, draftRestored]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Variants modal — null when closed.
  const [variantsFor, setVariantsFor] = useState<Question | null>(null);
  const [variantList, setVariantList] = useState<VariantCandidate[]>([]);
  const [variantBusy, setVariantBusy] = useState(false);
  const [variantSaving, setVariantSaving] = useState<Record<number, boolean>>({});
  const [variantSaved, setVariantSaved] = useState<Record<number, boolean>>({});
  const [variantErr, setVariantErr] = useState<string | null>(null);

  // ---- Class-fit suggestion (Feature B) ---------------------------------
  // The class list is for the dropdown; targetClassId is what the teacher
  // picked (empty string = "no class selected, show nothing"); classFit
  // holds the latest fit response for that class + the current selection.
  // None of these affect the existing compose flow if the teacher ignores
  // the dropdown.
  // Load saved last_teaching_context. Fire-and-forget — failure leaves saved=null.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb.from("profiles").select("last_teaching_context").eq("id", user.id).maybeSingle();
        if (cancelled) return;
        const saved = (data?.last_teaching_context as string | null) ?? null;
        if (saved) setSavedLastContext(saved);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // When the teacher picks a teaching context, re-derive the suggested
  // marking-scheme preset. The picker is the most precise signal we have
  // about the test's intent (more reliable than teacher's own exam_goal
  // since a teacher can run different contexts in the same week).
  useEffect(() => {
    if (!teachingContext) return;
    setSuggestedPreset(suggestPresetForGoal(teachingContext));
  }, [teachingContext]);
  const [classFit, setClassFit] = useState<ClassFit | null>(null);
  const [loadingFit, setLoadingFit] = useState(false);

  useEffect(() => {
    (async () => {
      setLoadingBank(true);
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setLoadingBank(false); return; }
      // Service-role library load. The previous direct read of
      // question_bank raced RLS and produced "0 approved questions in
      // your library" even after the rows were marked approved.
      const r = await fetch("/api/teacher/question-bank?status=approved", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json() as { items: Question[] };
        setBank(j.items || []);
      }
      setLoadingBank(false);
    })();
  }, []);

  async function openVariants(q: Question) {
    setVariantsFor(q);
    setVariantList([]);
    setVariantErr(null);
    setVariantSaving({});
    setVariantSaved({});
    setVariantBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const res = await fetch(`/api/qbank/${q.id}/variants`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed.");
      setVariantList((data.variants as VariantCandidate[]) || []);
    } catch (e) {
      setVariantErr(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setVariantBusy(false);
    }
  }

  async function saveOneVariant(idx: number) {
    if (!variantsFor) return;
    const v = variantList[idx];
    if (!v) return;
    setVariantSaving((s) => ({ ...s, [idx]: true }));
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const res = await fetch(`/api/qbank/${variantsFor.id}/variants/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          variants: [{
            stem: v.stem,
            options: v.options,
            correct_index: v.correct_index,
            explanation: v.explanation,
            bloom_level: v.bloom_level,
            topic: v.topic,
          }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed.");
      setVariantSaved((s) => ({ ...s, [idx]: true }));
      // Refresh the approved-questions library via the service-role
      // endpoint (the user-token client raced RLS and showed the library
      // as empty even when rows existed). Reuse the `session` already
      // resolved earlier in this function.
      const rr = await fetch("/api/teacher/question-bank?status=approved", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (rr.ok) {
        const jj = await rr.json() as { items: Question[] };
        setBank(jj.items || []);
      }
    } catch (e) {
      setVariantErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setVariantSaving((s) => ({ ...s, [idx]: false }));
    }
  }

  useEffect(() => {
    const topic = params.get("topic");
    const bloom = params.get("bloom");
    const q = params.get("search");
    // 2026-05-16 — context-carry from upstream pages (class dashboards,
    // review queue, dashboard tiles). Same vocabulary as other pages.
    const classParam = params.get("class");
    const subjectParam = params.get("subject");
    if (topic) setTopicFilter(topic);
    if (bloom && (bloom === "all" || isBloomLevel(bloom))) {
      setBloomFilter(bloom as BloomLevel | "all");
    }
    if (q) setSearch(q);
    if (classParam) setTargetClassId(classParam);
    if (subjectParam) setSubject(subjectParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ids = params.get("ids");
    if (!ids || bank.length === 0) return;
    const wanted = new Set(ids.split(",").filter(Boolean));
    setSelectedIds((prev) => {
      const have = new Set(prev);
      const additions: string[] = [];
      bank.forEach((q) => {
        if (wanted.has(q.id) && !have.has(q.id)) additions.push(q.id);
      });
      return additions.length ? [...prev, ...additions] : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank]);

  // 2026-05-16 — class auto-cascade. When the teacher picks a class,
  // pre-fill any still-empty defaults from the class record so they
  // don't re-state info we already know.
  useEffect(() => {
    if (!targetClassId) return;
    // Finding #37 fix (B.2): renamed from teacherClasses (undefined in
    // this scope) to classes (the actual state variable from line ~271).
    const cls = (classes.find((c) => c.id === targetClassId) || null) as
      | { id: string; subject?: string | null }
      | null;
    if (cls?.subject && !subject) {
      setSubject(cls.subject);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetClassId]);

  const topicCounts = useMemo(() => {
    const m = new Map<string, number>();
    bank.forEach((q) => {
      const k = topicKey(q.topic);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m, ([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  }, [bank]);

  // Unique categories present in the bank with counts, for the dropdown.
  // 2026-05-15 — counts surfaced so teachers see "JEE (234) · Class 10 (67)"
  // before filtering; helps spot distribution issues at a glance.
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let nullCount = 0;
    for (const q of bank) {
      const c = (q.category || "").trim();
      if (!c) { nullCount++; continue; }
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const slugs = Array.from(counts.keys()).sort((a, b) =>
      categoryLabel(a).localeCompare(categoryLabel(b)),
    );
    return { slugs, counts, hasNull: nullCount > 0, nullCount };
  }, [bank]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return bank.filter((q) => {
      if (bloomFilter !== "all" && q.bloom_level !== bloomFilter) return false;
      if (topicFilter !== "all" && topicKey(q.topic) !== topicFilter) return false;
      // 2026-05-15 — category filter. "_none" matches NULL/empty.
      if (categoryFilter !== "all") {
        const cat = (q.category || "").trim();
        if (categoryFilter === "_none") {
          if (cat) return false;
        } else if (cat !== categoryFilter) {
          return false;
        }
      }
      if (needle) {
        const hay = `${q.stem} ${topicKey(q.topic)}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [bank, bloomFilter, topicFilter, categoryFilter, search]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedQuestions = useMemo(
    () => selectedIds.map((id) => bank.find((q) => q.id === id)).filter(Boolean) as Question[],
    [selectedIds, bank]
  );

  function add(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }
  function remove(id: string) {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }
  function toggle(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function move(index: number, delta: -1 | 1) {
    setSelectedIds((prev) => {
      const next = [...prev];
      const j = index + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }
  // Finding #64: moveTo + drag state for HTML5-native drag-drop reorder.
  function moveTo(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    setSelectedIds((prev) => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  function addAllVisible() {
    setSelectedIds((prev) => {
      const have = new Set(prev);
      const additions: string[] = [];
      filtered.forEach((q) => {
        if (!have.has(q.id)) additions.push(q.id);
      });
      return additions.length ? [...prev, ...additions] : prev;
    });
  }
  function clearAll() { setSelectedIds([]); }

  async function deleteFromLibrary(id: string) {
    if (!confirm("Permanently delete this question from your bank? It will also be removed from this test draft.")) return;
    // Route through the service-role endpoint instead of hitting
    // question_bank with the user-token client. The read path on this
    // page already does so for the same reason — RLS on the edge has an
    // intermittent race where a legitimate delete silently affects zero
    // rows.
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      alert("Not signed in.");
      return;
    }
    const res = await fetch(`/api/teacher/question-bank/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({} as { error?: string }));
      alert(`Could not delete: ${j.error || `HTTP ${res.status}`}`);
      return;
    }
    setBank((arr) => arr.filter((q) => q.id !== id));
    setSelectedIds((arr) => arr.filter((x) => x !== id));
  }

  const selectedTopics = useMemo(() => {
    const set = new Set<string>();
    selectedQuestions.forEach((q) => set.add(topicKey(q.topic)));
    return Array.from(set);
  }, [selectedQuestions]);
  const mixedTopics = selectedTopics.length > 1;

  // 2026-05-15 (Vipin #2) — auto-suggest a quiz name from the dominant topic
  // + category once the teacher selects questions. The teacher can always
  // type their own; we only auto-fill while `name` is empty and the user
  // hasn't explicitly cleared it. The suggestion shape:
  //   - one topic, no category:  "Photosynthesis test"
  //   - one topic + category:    "Photosynthesis · Class 10 boards"
  //   - multiple topics:         "Mixed practice · 3 topics"
  // Format kept short enough to fit the test-name field comfortably.
  const suggestedName = useMemo(() => {
    if (selectedQuestions.length === 0) return "";
    // Dominant category — most common non-null category among selected questions.
    const catCounts = new Map<string, number>();
    let totalWithCat = 0;
    for (const q of selectedQuestions) {
      const c = (q.category || "").trim();
      if (!c) continue;
      catCounts.set(c, (catCounts.get(c) || 0) + 1);
      totalWithCat++;
    }
    let dominantCat: string | null = null;
    if (totalWithCat > 0) {
      let maxN = 0;
      for (const [k, v] of catCounts) {
        if (v > maxN) { maxN = v; dominantCat = k; }
      }
      // Require ≥50% dominance to surface the category in the name (otherwise
      // it's a mixed-category quiz and the topic alone is more honest).
      if (maxN * 2 < totalWithCat) dominantCat = null;
    }
    const catSuffix = dominantCat ? ` · ${categoryLabelShared(dominantCat)}` : "";
    if (selectedTopics.length === 1 && selectedTopics[0] !== NO_TOPIC) {
      return `${selectedTopics[0]} test${catSuffix}`;
    }
    if (selectedTopics.length > 1) {
      return `Mixed practice · ${selectedTopics.length} topics${catSuffix}`;
    }
    // Fallback when topics are all NO_TOPIC.
    return dominantCat ? `${categoryLabelShared(dominantCat)} test` : "";
  }, [selectedQuestions, selectedTopics]);

  // Apply the suggested name when the teacher hasn't typed anything yet.
  // Tracks `nameAutoApplied` so a teacher who clears the field (after we
  // suggested) doesn't get auto-overwritten again. Tracks `nameManuallySet`
  // so any keystroke locks in the teacher's choice.
  const [nameManuallySet, setNameManuallySet] = useState(false);
  useEffect(() => {
    if (nameManuallySet) return;
    if (!suggestedName) return;
    if (name && name !== suggestedName) return; // teacher typed something else
    setName(suggestedName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedName, nameManuallySet]);


  const recommendedMinutes = useMemo(
    () => recommendedQuizMinutes(selectedQuestions.map((q) => ({ bloom_level: q.bloom_level }))),
    [selectedQuestions]
  );
  useEffect(() => {
    if (!timeManuallySet && recommendedMinutes > 0) {
      setTime(recommendedMinutes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedMinutes]);

  // ---- Feature B: load the teacher's classes for the dropdown ---------
  // Best-effort. If this fails (RLS, network, schema drift) the class-fit
  // card silently hides and the existing compose flow is unaffected.
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
        if (!cancelled && Array.isArray(j.classes)) setClasses(j.classes);
      } catch {
        /* hide the card on failure */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- 2026-05-15 (Vipin #1): Class-vs-category mismatch warning -------
  // Independent of class-fit (which is attempt-history based). This warns
  // when the teacher tries to assign senior/competitive-cohort questions
  // to a younger class — the danger Vipin called out: "if I select a lower
  // class then generate or assign JEE-type higher-class questions, warn
  // the teacher". Detection is purely from category metadata, not the
  // attempt history, so it works on day 1.
  const targetClass = useMemo(
    () => classes.find((c) => c.id === targetClassId) || null,
    [classes, targetClassId],
  );
  const classCategorySlug = useMemo(
    () => targetClass ? classGradeToCategory(targetClass.grade) : null,
    [targetClass],
  );
  const classMismatchWarning = useMemo(() => {
    if (!targetClass || selectedQuestions.length === 0) return null;
    const cats = selectedQuestions.map((q) => q.category || null);
    return classQuestionMismatchWarning(classCategorySlug, cats);
  }, [targetClass, classCategorySlug, selectedQuestions]);

  // ---- Feature B: recompute class-fit when class or selection changes -
  // Debounced so that rapidly toggling questions doesn't spam the API.
  // No-ops to "no class selected" or "empty selection".
  useEffect(() => {
    if (!targetClassId || selectedIds.length === 0) {
      setClassFit(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoadingFit(true);
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const params = new URLSearchParams({
          class_id: targetClassId,
          question_ids: selectedIds.join(","),
        });
        const r = await fetch(`/api/teacher/class-fit?${params.toString()}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!r.ok) {
          if (!cancelled) setClassFit(null);
          return;
        }
        const j = await r.json() as ClassFit & { ok?: boolean };
        if (!cancelled) setClassFit({
          matched: j.matched ?? 0,
          total: j.total ?? selectedIds.length,
          attempts: j.attempts ?? 0,
          avg_score_pct: j.avg_score_pct ?? null,
        });
      } catch {
        if (!cancelled) setClassFit(null);
      } finally {
        if (!cancelled) setLoadingFit(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [targetClassId, selectedIds]);

  async function create() {
    setErr(null);
    if (!name.trim()) return setErr("Please name your test.");
    if (selectedIds.length === 0) return setErr("Add at least one question.");

    if (mixedTopics) {
      const topicCount: Record<string, number> = {};
      for (const q of selectedQuestions) {
        const t = q.topic || "(no topic)";
        topicCount[t] = (topicCount[t] || 0) + 1;
      }
      const sortedTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]);
      const ok = confirm(
        `This quiz spans ${selectedTopics.length} different topics:\n\n` +
        sortedTopics.map(([t, c]) => `  • ${t} (${c} question${c === 1 ? "" : "s"})`).join("\n") +
        `\n\nDid you intend to mix topics? Click OK to continue, or Cancel to revise.`
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in");

      // Finding #66: extended from 4 to 8 retries + clearer error.
      let code = generateQuizCode();
      let codeUnique = false;
      for (let i = 0; i < 8; i++) {
        const { data: existing } = await sb.from("quizzes").select("id").eq("code", code).maybeSingle();
        if (!existing) { codeUnique = true; break; }
        code = generateQuizCode();
      }
      if (!codeUnique) {
        throw new Error("Could not allocate a unique quiz code after 8 tries. Refresh and try again.");
      }

      const blooms = Array.from(new Set(selectedQuestions.map((q) => q.bloom_level)));
      let quizRow: { id: string } | null = null;
      // marking_scheme is the per-test rule. NULL means legacy +1/0/0
      // (lib/scoring.ts → resolveScheme treats NULL as the default).
      // The fallback insert (when migration 27's recommended_minutes is
      // missing) also writes marking_scheme — if migration 76 hasn't
      // run yet, the catch below downgrades a SECOND time.
      const insertWithRecommended = await sb.from("quizzes").insert({
        owner_id: user.id,
        name,
        subject: subject.trim() || null,
        code,
        time_limit_minutes: time,
        recommended_minutes: recommendedMinutes || null,
        bloom_filter: blooms,
        marking_scheme: markingScheme,
      }).select("id").single();
      if (insertWithRecommended.error) {
        const msg = insertWithRecommended.error.message;
        if (/column.+(recommended_minutes|marking_scheme).+does not exist/i.test(msg)) {
          const fallback = await sb.from("quizzes").insert({
            owner_id: user.id,
            name,
            subject: subject.trim() || null,
            code,
            time_limit_minutes: time,
            bloom_filter: blooms,
          }).select("id").single();
          if (fallback.error) throw fallback.error;
          quizRow = fallback.data as { id: string };
        } else {
          throw insertWithRecommended.error;
        }
      } else {
        quizRow = insertWithRecommended.data as { id: string };
      }
      const quiz = quizRow!;

      const rows = selectedIds.map((qid, i) => ({
        quiz_id: quiz!.id,
        question_id: qid,
        position: i,
      }));
      const { error: rerr } = await sb.from("quiz_questions").insert(rows);
      if (rerr) throw rerr;

      // Sticky marking-scheme persistence (migration 77). Quiz + questions
      // inserted successfully — write the teacher's pick back to
      // profile.last_marking_scheme so the picker pre-fills with this
      // scheme next time on any surface. Best-effort, silent on failure.
      if (markingScheme && typeof markingScheme === "object") {
        try {
          await sb
            .from("profiles")
            .update({ last_marking_scheme: markingScheme })
            .eq("id", user.id);
        } catch { /* silent — preference will write on next save */ }
      }

      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        fetch(`/api/quizzes/${quiz!.id}/classify`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).catch(() => {});
      }

      router.push(`/teacher/quizzes/${quiz!.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create test");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto fade-in">
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-sm">
            <Layers size={20} />
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Build &amp; Assign a test</h1>
        </div>
        <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
          Browse your approved question library on the left. Pick the ones you want, then name and configure the test on the right.
        </p>
        <ol className="mt-5 flex items-center gap-2 text-xs font-medium text-slate-500 flex-wrap">
          <li className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-sky-400"></span>Filter your bank</li>
          <span className="text-slate-300">›</span>
          <li className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500"></span>Select questions</li>
          <span className="text-slate-300">›</span>
          <li className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-purple-400"></span>Configure</li>
          <span className="text-slate-300">›</span>
          <li className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400"></span>Save &amp; share</li>
        </ol>
      </header>

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          {/* 2026-05-16 — auto-save restore prompt. Surfaces a draft from
              the last 24h when the teacher reopens the page. */}
          {draftRestored && (
            <div className="mt-3 mb-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 flex items-center gap-3 flex-wrap">
              <span className="text-sm text-emerald-900">
                You have a draft from {Math.max(1, Math.floor((Date.now() - draftRestored.savedAt) / 60000))} minute(s) ago
                {draftRestored.name ? <>: <strong>{draftRestored.name}</strong></> : null}
                {" "}({draftRestored.selectedIds.length} question{draftRestored.selectedIds.length === 1 ? "" : "s"}).
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => applyDraft(draftRestored)}>Restore</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={discardDraft}>Discard</button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {lastSavedAt && (
            <div className="text-xs text-slate-500 inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              Auto-saved at {new Date(lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
          <div className="text-sm muted">
            {bank.length} approved question{bank.length === 1 ? "" : "s"} in your library
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_400px] gap-6 mt-6 items-start">
        <section className="space-y-3">
          {/* Finding #61: active-filter pills. */}
          {(bloomFilter !== "all" || topicFilter !== "all" || categoryFilter !== "all" || search.trim() !== "") && (
            <div className="flex items-center gap-2 flex-wrap text-xs bg-emerald-50/40 border border-emerald-100 rounded-lg px-3 py-2">
              <span className="font-semibold text-emerald-900">Active filters:</span>
              {bloomFilter !== "all" && (
                <button type="button" onClick={() => setBloomFilter("all")} className="px-2 py-0.5 rounded-full bg-white border border-emerald-200 hover:bg-red-50 hover:border-red-300 text-slate-700 flex items-center gap-1">
                  Bloom: {bloomFilter} <X size={11} />
                </button>
              )}
              {topicFilter !== "all" && (
                <button type="button" onClick={() => setTopicFilter("all")} className="px-2 py-0.5 rounded-full bg-white border border-emerald-200 hover:bg-red-50 hover:border-red-300 text-slate-700 flex items-center gap-1">
                  Topic: {topicFilter} <X size={11} />
                </button>
              )}
              {categoryFilter !== "all" && (
                <button type="button" onClick={() => setCategoryFilter("all")} className="px-2 py-0.5 rounded-full bg-white border border-emerald-200 hover:bg-red-50 hover:border-red-300 text-slate-700 flex items-center gap-1">
                  Category: {categoryFilter} <X size={11} />
                </button>
              )}
              {search.trim() !== "" && (
                <button type="button" onClick={() => setSearch("")} className="px-2 py-0.5 rounded-full bg-white border border-emerald-200 hover:bg-red-50 hover:border-red-300 text-slate-700 flex items-center gap-1">
                  Search: &quot;{search.trim().slice(0, 18)}{search.trim().length > 18 ? "…" : ""}&quot; <X size={11} />
                </button>
              )}
              <button
                type="button"
                onClick={() => { setBloomFilter("all"); setTopicFilter("all"); setCategoryFilter("all"); setSearch(""); }}
                className="ml-auto text-emerald-700 hover:underline font-semibold"
              >Clear all</button>
            </div>
          )}
          {/* Finding #59 (Round 13): bloomFilter × teaching-context warning. */}
          {bloomFilter !== "all" && teachingContext && (() => {
            const supported: Record<string, string[]> = {
              cat: ["apply","analyze","evaluate"],
              jee_main: ["understand","apply","analyze","evaluate"],
              jee_advanced: ["understand","apply","analyze","evaluate"],
              neet: ["remember","understand","apply","analyze"],
              gmat: ["apply","analyze","evaluate"],
              gre: ["understand","apply","analyze","evaluate"],
              upsc: ["remember","understand","apply","analyze"],
              ielts: ["understand","apply","analyze"],
              clat: ["remember","understand","apply","analyze"],
              bitsat: ["understand","apply","analyze"],
              sat: ["apply","analyze"],
              gate: ["apply","analyze","evaluate"],
              nda: ["remember","understand","apply"],
              cuet: ["remember","understand","apply"],
            };
            const list = supported[teachingContext];
            if (!list) return null;
            if (list.includes(bloomFilter)) return null;
            return (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                <span aria-hidden="true">⚠</span>
                <span>The teaching context ({teachingContext}) doesn&apos;t typically test &quot;{bloomFilter}&quot;-level questions. The bank below will likely be empty. Switch to <strong>{list.join(" / ")}</strong> or pick a different teaching context.</span>
              </div>
            );
          })()}
          {/* 2026-05-16 — recent-topic quick chips. */}
          {recentTopics.length > 0 && bank.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="muted">Recent:</span>
              {recentTopics.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="px-2 py-1 rounded-full border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-300 text-slate-700"
                  onClick={() => setTopicFilter(t)}
                >{t}</button>
              ))}
            </div>
          )}
          {bank.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Layers size={14} /> Topics
                <span className="muted font-normal normal-case ml-auto">most questions first</span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                <TopicChip
                  label="All topics"
                  count={bank.length}
                  active={topicFilter === "all"}
                  onClick={() => setTopicFilter("all")}
                />
                {topicCounts.map((t) => (
                  <TopicChip
                    key={t.key}
                    label={t.key}
                    count={t.count}
                    active={topicFilter === t.key}
                    onClick={() => setTopicFilter(t.key)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="card flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                className="input pl-9"
                placeholder="Search question text or topic..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className="select max-w-[170px]"
              value={bloomFilter}
              onChange={(e) => setBloomFilter(e.target.value as BloomLevel | "all")}
            >
              <option value="all">All Bloom levels</option>
              {BLOOM_LEVELS.map((l) => <option key={l} value={l}>{BLOOM_META[l].label}</option>)}
            </select>
            {/* 2026-05-15 (migration 90) — category filter. Only shown when
                the bank actually has tagged rows or the legacy NULL bucket
                contains content — keeps the toolbar tidy for first-time
                teachers whose bank is all one category. */}
            {(categoryOptions.slugs.length > 0 || categoryOptions.hasNull) && (
              <select
                className="select max-w-[200px]"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                title="Filter by the teaching context a question was generated for"
              >
                <option value="all">All categories ({bank.length})</option>
                {categoryOptions.slugs.map((c) => (
                  <option key={c} value={c}>{categoryLabel(c)} ({categoryOptions.counts.get(c) || 0})</option>
                ))}
                {categoryOptions.hasNull && (
                  <option value="_none">{NO_CATEGORY} ({categoryOptions.nullCount})</option>
                )}
              </select>
            )}
            <button type="button" className="btn btn-secondary" onClick={addAllVisible} disabled={filtered.length === 0}>
              Add all visible
            </button>
            <span className="ml-auto text-xs muted whitespace-nowrap">{filtered.length} shown</span>
          </div>

          {/* 2026-05-15 — Bulk-tag legacy uncategorized questions. Visible only
              when filter = Uncategorized AND the teacher has set a teaching
              context on their profile. One click backfills the category on
              every visible NULL row so future filtering works. */}
          {categoryFilter === "_none" && filtered.length > 0 && teacherExamGoal && (
            <div className="card flex items-center justify-between gap-3 flex-wrap text-sm">
              <span>
                <strong>{filtered.length}</strong> uncategorized questions visible.
                Tag them as <strong>{categoryLabel(teacherExamGoal)}</strong>?
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={async () => {
                  if (!teacherExamGoal) return;
                  if (!confirm(`Tag ${filtered.length} questions as "${categoryLabel(teacherExamGoal)}"? You can change individual categories later.`)) return;
                  try {
                    const sb = supabaseBrowser();
                    const { data: { session } } = await sb.auth.getSession();
                    if (!session) { alert("Not signed in."); return; }
                    const r = await fetch("/api/teacher/question-bank", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${session.access_token}`,
                      },
                      body: JSON.stringify({
                        action: "bulk_tag_category",
                        category: teacherExamGoal,
                        ids: filtered.map((q) => q.id),
                      }),
                    });
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}));
                      alert(`Bulk tag failed: ${j.error || `HTTP ${r.status}`}`);
                      return;
                    }
                    // Optimistically update the in-memory bank so the UI
                    // reflects the new tags without a refetch.
                    const taggedIds = new Set(filtered.map((q) => q.id));
                    setBank((arr) => arr.map((q) => taggedIds.has(q.id) ? { ...q, category: teacherExamGoal } : q));
                    setCategoryFilter("all");
                  } catch (e) {
                    alert(e instanceof Error ? e.message : "Bulk tag failed");
                  }
                }}
              >
                Tag {filtered.length} as {categoryLabel(teacherExamGoal)}
              </button>
            </div>
          )}

          {/* 2026-05-16 — bulk-select shortcuts. ~80% click reduction for
              the common "build a test from the latest batch" workflow. */}
          {!loadingBank && filtered.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="muted">Bulk select:</span>
              <button
                type="button"
                className="px-2 py-1 rounded border border-slate-200 hover:bg-emerald-50 hover:border-emerald-300 text-slate-700"
                onClick={() => {
                  const newIds = filtered.map((q) => q.id);
                  setSelectedIds((prev) => Array.from(new Set([...prev, ...newIds])));
                }}
              >All filtered ({filtered.length})</button>
              <button
                type="button"
                className="px-2 py-1 rounded border border-slate-200 hover:bg-emerald-50 hover:border-emerald-300 text-slate-700"
                onClick={() => {
                  const last10 = filtered.slice(0, 10).map((q) => q.id);
                  setSelectedIds((prev) => Array.from(new Set([...prev, ...last10])));
                }}
              >Latest 10</button>
              <button
                type="button"
                className="px-2 py-1 rounded border border-slate-200 hover:bg-emerald-50 hover:border-emerald-300 text-slate-700"
                onClick={() => {
                  const last20 = filtered.slice(0, 20).map((q) => q.id);
                  setSelectedIds((prev) => Array.from(new Set([...prev, ...last20])));
                }}
              >Latest 20</button>
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  className="px-2 py-1 rounded border border-rose-200 hover:bg-rose-50 text-rose-700 ml-auto"
                  onClick={() => setSelectedIds([])}
                >Clear selection</button>
              )}
            </div>
          )}
          {loadingBank ? (
            <div className="card grid place-items-center py-12"><div className="spinner" /></div>
          ) : bank.length === 0 ? (
            <div className="card text-center py-12">
              <div className="text-4xl mb-2">📚</div>
              <div className="font-semibold mb-1">Your library is empty</div>
              <div className="muted text-sm mb-4">Generate and approve some questions to start composing.</div>
              <a href="/teacher/generate" className="btn btn-primary inline-flex"><Sparkles size={16} /> Generate questions</a>
            </div>
          ) : filtered.length === 0 ? (
            <div className="card text-center py-12">
              {/* 2026-05-16 — actionable empty state. Instead of a dead-end
                  caption, offer one-click escape hatches. */}
              <div className="text-3xl mb-2">🔎</div>
              <div className="font-semibold text-slate-700 mb-3">No questions match these filters.</div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setTopicFilter("all");
                    setBloomFilter("all");
                    setSearch("");
                  }}
                >Clear all filters</button>
                <a
                  href={`/teacher/generate?${new URLSearchParams({
                    ...(topicFilter !== "all" && topicFilter !== NO_TOPIC ? { topic: topicFilter } : {}),
                    ...(bloomFilter !== "all" ? { bloom: bloomFilter } : {}),
                    ...(targetClassId ? { class: targetClassId } : {}),
                  }).toString()}`}
                  className="btn btn-primary btn-sm inline-flex items-center gap-1"
                >
                  <Sparkles size={14} /> Generate {topicFilter !== "all" ? `on ${topicFilter}` : "questions"} now
                </a>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((q) => {
                const on = selectedSet.has(q.id);
                return (
                  <div
                    key={q.id}
                    className={`card transition py-3 ${on ? "border-emerald-500 bg-emerald-50/40" : "card-hover"}`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggle(q.id)}
                        className={`mt-0.5 w-7 h-7 rounded-full grid place-items-center transition shrink-0 ${
                          on
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-100 text-slate-500 hover:bg-emerald-100 hover:text-emerald-700"
                        }`}
                        aria-label={on ? "Remove from test" : "Add to test"}
                        title={on ? "Added — click to remove" : "Add to test"}
                      >
                        {on ? <Check size={16} /> : <Plus size={16} />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <BloomBadge level={q.bloom_level} />
                          {/* 2026-05-15 — category badge so teachers can tell at
                              a glance which class/exam this question was made
                              for. Slate styling keeps it visually quieter than
                              the Bloom badge (which is the primary signal). */}
                          {q.category && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                              {categoryLabel(q.category)}
                            </span>
                          )}
                          {q.topic && <span className="text-xs muted">{q.topic}</span>}
                        </div>
                        <div className="text-sm font-medium">{q.stem}</div>
                        <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 mt-2 text-sm">
                          {q.options.map((o, i) => (
                            <li
                              key={i}
                              className={
                                i === q.correct_index
                                  ? "text-emerald-700 font-semibold"
                                  : "text-slate-600"
                              }
                            >
                              <span className="text-xs uppercase tracking-wide opacity-70 mr-1">
                                {String.fromCharCode(65 + i)}.
                              </span>
                              {o}
                              {i === q.correct_index && (
                                <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700/80">
                                  ✓ correct
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                        {q.explanation && (
                          <p className="text-xs muted mt-2">
                            <strong className="text-slate-600">Why:</strong> {q.explanation}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openVariants(q)}
                          className="p-1.5 text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 rounded"
                          title="Generate isomorphic variants"
                          aria-label="Generate variants for this question"
                        >
                          <Wand2 size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteFromLibrary(q.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                          title="Delete from library"
                          aria-label="Delete question from library"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <aside className="lg:sticky lg:top-6 self-start space-y-3">
          {/* ---------- TEACHING CONTEXT (mirrors /teacher/generate) ---------- */}
          <div className="card">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-semibold text-sm">Who is this test for?</h3>
              <span className="text-xs muted ml-auto">Picks the scoring style + unlocks cross-checks</span>
            </div>
            {(() => {
              // Seed picker once: prefer saved last-context, then class.grade-derived.
              if (teachingContext === null) {
                const cls = classes.find((c) => c.id === targetClassId) || null;
                const seed = defaultTeachingContext({ savedLastContext, classGrade: cls?.grade ?? null });
                if (seed) setTimeout(() => setTeachingContext(seed), 0);
              }
              return null;
            })()}
            <select
              className="select w-full text-sm"
              value={teachingContext ?? ""}
              onChange={(e) => {
                const v = e.target.value || null;
                setTeachingContext(v);
                setValidationOverride(false);
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
            {teachingContext && !contextFit && (
              <p className="text-[11px] text-emerald-700 mt-1">
                Test composed for <strong>{categoryLabel(teachingContext)}</strong>.
              </p>
            )}
            {contextFit && contextFit.severity !== "none" && (
              <div className={`mt-2 rounded-lg border px-3 py-2 text-sm ${
                contextFit.severity === "hard"
                  ? "border-red-300 bg-red-50 text-red-900"
                  : "border-amber-300 bg-amber-50 text-amber-900"
              }`}>
                <div className="font-semibold mb-0.5">
                  {contextFit.severity === "hard" ? "Class / context mismatch:" : "Heads up:"}
                </div>
                <div>{contextFit.message}</div>
                {contextFit.detail && <div className="text-xs opacity-80 mt-1">{contextFit.detail}</div>}
                {contextFit.severity === "hard" && (
                  <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={validationOverride}
                      onChange={(e) => setValidationOverride(e.target.checked)}
                    />
                    <span className="text-xs"><strong>I really mean this</strong> — assign anyway.</span>
                  </label>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <label className="label">Test name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameManuallySet(true); }}
              placeholder="e.g. End-of-unit assessment"
            />
            {/* 2026-05-15 (Vipin #2) — auto-suggestion hint. Only shown when
                the suggested name was auto-applied AND the teacher hasn't
                edited it yet. Tells them what's going on so the auto-fill
                feels intentional, not magical. */}
            {!nameManuallySet && suggestedName && name === suggestedName && (
              <p className="text-xs muted mt-1">
                Auto-named from your selected questions. Edit freely.
              </p>
            )}
            <label className="label mt-3">Subject <span className="muted text-xs">(optional)</span></label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. your subject area" />
            <div className="flex items-center gap-2 mt-3">
              <Clock size={14} className="text-slate-400" />
              <label className="label !mb-0 !mt-0">Time limit</label>
              <input
                type="number"
                min={1}
                max={180}
                className="input w-20 ml-auto"
                value={time}
                onChange={(e) => {
                  setTime(Math.max(1, Math.min(180, +e.target.value || 1)));
                  setTimeManuallySet(true);
                }}
              />
              <span className="text-sm muted">min</span>
            </div>
            {recommendedMinutes > 0 && (
              <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                <span className="muted">
                  Suggested:{" "}
                  <strong className="text-slate-700">
                    {recommendedMinutes} min
                  </strong>
                  <span className="ml-1">based on Bloom mix of selected questions</span>
                </span>
                {timeManuallySet && time !== recommendedMinutes && (
                  <button
                    type="button"
                    className="text-emerald-700 font-semibold hover:underline"
                    onClick={() => { setTime(recommendedMinutes); setTimeManuallySet(false); }}
                    title="Use the suggested time"
                  >
                    Use suggested
                  </button>
                )}
              </div>
            )}

            {/* Marking scheme picker (migration 76). Default PRACTICE
                (+1 correct / 0 wrong) keeps quizzes friendly. Teachers
                running JEE / NEET / CAT mocks pick the matching preset;
                the negative-marks toggle lets them run "JEE-weighted but
                no penalty" diagnostics.
                2026-05-15: the picker now reads suggestedPreset from the
                teacher's exam_goal (teaching context) so JEE coaches see
                "Switch to JEE_MAIN" out of the box, and a primary/middle
                teacher trying to use negative marking sees an inline
                warning. */}
            <div className="mt-4">
              {/* Findings #55 + #56 + #57: cross-field warnings. */}
            {(() => {
              const warnings: { msg: string; tone: "warn" | "info" }[] = [];
              if (selectedIds.length > 0) {
                const secPerQ = Math.round((time * 60) / selectedIds.length);
                if (secPerQ < 45) {
                  warnings.push({ tone: "warn", msg: `Only ~${secPerQ} sec per question (${time} min ÷ ${selectedIds.length}). Students will struggle to finish.` });
                } else if (secPerQ > 300) {
                  warnings.push({ tone: "info", msg: `~${Math.round(secPerQ / 60)} min per question — generous. If intentional, ignore.` });
                }
              }
              if (name.trim() && subject.trim()) {
                const nameTokens = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
                const subjTokens = subject.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
                const fam: Record<string, string[]> = {
                  math: ["math","maths","mathematics","algebra","geometry","trigonometry","calculus","arithmetic","lcm","hcf","gcd"],
                  science: ["science","physics","chemistry","biology","botany","zoology","force","cell"],
                  english: ["english","literature","grammar","vocabulary","reading","writing"],
                  history: ["history","historical","civilization","empire","war"],
                  geography: ["geography","climate","continent","river"],
                };
                let conflict: string | null = null;
                for (const [f, ws] of Object.entries(fam)) {
                  const sIs = subjTokens.some((t) => ws.includes(t));
                  if (!sIs) continue;
                  const nOther = Object.entries(fam).some(([of, ow]) => of !== f && Array.from(nameTokens).some((t) => ow.includes(t)));
                  if (nOther) { conflict = f; break; }
                }
                if (conflict) {
                  warnings.push({ tone: "warn", msg: `Test name mentions a topic that doesn't match the "${subject.trim()}" subject.` });
                }
              }
              // Finding #57: marking-scheme × deep-Bloom mix
              if (markingScheme && (markingScheme as { negative_marks_enabled?: boolean }).negative_marks_enabled && selectedQuestions.length > 0) {
                const deep = selectedQuestions.filter((q) => q.bloom_level === "apply" || q.bloom_level === "analyze" || q.bloom_level === "evaluate" || q.bloom_level === "create").length;
                const deepFrac = deep / selectedQuestions.length;
                if (deepFrac >= 0.6) {
                  warnings.push({ tone: "warn", msg: `Negative marking + ${Math.round(deepFrac * 100)}% deep-Bloom questions = over-penalty risk. Consider a non-penalty preset.` });
                }
              }
              if (warnings.length === 0) return null;
              return (
                <div className="mt-3 space-y-2">
                  {warnings.map((w, i) => (
                    <div key={i} className={`rounded-md px-3 py-2 text-xs flex items-start gap-2 ${
                      w.tone === "warn"
                        ? "bg-amber-50 border border-amber-200 text-amber-900"
                        : "bg-sky-50 border border-sky-200 text-sky-900"
                    }`}>
                      <span aria-hidden="true">{w.tone === "warn" ? "⚠" : "ℹ"}</span>
                      <span>{w.msg}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            <MarkingSchemePicker
                value={markingScheme}
                onChange={setMarkingScheme}
                suggested={suggestedPreset}
              />
              {negMarkingWarn && (
                <p className="text-xs mt-2 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800">
                  {negMarkingWarn}
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold flex items-center gap-2">
                Your quiz
                <span className="text-sm muted font-normal">({selectedIds.length})</span>
              </h3>
              {selectedIds.length > 0 && (
                <button type="button" onClick={clearAll} className="text-xs text-slate-500 hover:text-red-600">Clear</button>
              )}
            </div>

            {selectedQuestions.length > 0 && (
              <>
                <BloomMiniChart items={selectedQuestions} />
                <div className="text-xs muted mt-2">
                  {selectedTopics.length === 1
                    ? `Topic: ${selectedTopics[0]}`
                    : `${selectedTopics.length} topics`}
                </div>
                {mixedTopics && (
                  <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                    Heads up — this test mixes topics: {selectedTopics.join(", ")}.
                  </div>
                )}
              </>
            )}

            {selectedQuestions.length === 0 ? (
              <div className="text-center py-10 text-sm muted border-2 border-dashed border-slate-200 rounded-lg mt-2">
                Click <Plus size={14} className="inline align-middle text-emerald-600" /> on any question in the library to add it here.
              </div>
            ) : (
              <ol className="space-y-2 mt-3 max-h-[60vh] overflow-y-auto pr-1">
                {selectedQuestions.map((q, i) => (
                  <li
                    key={q.id}
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(i);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragIndex !== null && dragIndex !== i) setDropTargetIndex(i);
                    }}
                    onDragLeave={() => { if (dropTargetIndex === i) setDropTargetIndex(null); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null && dragIndex !== i) moveTo(dragIndex, i);
                      setDragIndex(null);
                      setDropTargetIndex(null);
                    }}
                    onDragEnd={() => { setDragIndex(null); setDropTargetIndex(null); }}
                    className={`p-3 rounded-lg border bg-white transition-colors ${
                      dragIndex === i
                        ? "border-emerald-300 bg-emerald-50/50 opacity-60"
                        : dropTargetIndex === i
                          ? "border-emerald-500 ring-2 ring-emerald-200"
                          : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing shrink-0 mt-0.5 select-none" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
                      <span className="text-xs font-bold text-slate-400 w-5 mt-0.5">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <BloomBadge level={q.bloom_level} />
                          {q.topic && <span className="text-xs muted truncate">{q.topic}</span>}
                        </div>
                        <div className="text-sm line-clamp-2">{q.stem}</div>
                      </div>
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button type="button"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded text-slate-500"
                          title="Move up"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button type="button"
                          onClick={() => move(i, 1)}
                          disabled={i === selectedQuestions.length - 1}
                          className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded text-slate-500"
                          title="Move down"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                      <button type="button"
                        onClick={() => remove(q.id)}
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded shrink-0"
                        title="Remove from test"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* ---------- Feature B: Class-fit suggestion ---------- */}
          {classes.length > 0 && (
            <ClassFitCard
              classes={classes}
              targetClassId={targetClassId}
              setTargetClassId={setTargetClassId}
              fit={classFit}
              loading={loadingFit}
              hasSelection={selectedQuestions.length > 0}
            />
          )}

          {/* 2026-05-15 (Vipin #1): category-mismatch warning. Surfaces
              when the target class is junior (e.g. Class 8) but the quiz
              contains questions generated for a senior/competitive cohort
              (JEE / Class 12 boards / etc.). Not a hard block — sometimes
              the teacher legitimately wants to stretch a class — just
              informed consent before clicking Create. */}
          {classMismatchWarning && (
            // 2026-05-16: promoted to a prominent banner. The teacher
            // is about to bind questions of a different category to
            // a class — they need an unmissable confirm step.
            <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3 shadow-sm">
              <div className="flex items-start gap-3">
                <span aria-hidden className="text-2xl leading-none">⚠️</span>
                <div className="flex-1">
                  <div className="font-bold text-amber-900 text-base mb-1">Category mismatch — please confirm</div>
                  <div className="text-sm text-amber-900 leading-relaxed">{classMismatchWarning}</div>
                  <div className="mt-2 text-[12px] text-amber-800 opacity-90">
                    You can still proceed if this is a deliberate stretch challenge — but double-check this is what you intend before clicking Create.
                  </div>
                </div>
              </div>
            </div>
          )}

          {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

          <button type="button"
            className="btn btn-primary w-full"
            disabled={busy || selectedIds.length === 0 || !name.trim()}
            onClick={create}
          >
            {busy ? <><span className="spinner" /> Creating…</> : `Create test (${selectedIds.length})`}
          </button>
        </aside>
      </div>

      {/* ============ VARIANTS MODAL ============ */}
      {variantsFor && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Wand2 size={18} className="text-emerald-700 shrink-0" />
                <div className="min-w-0">
                  <div className="font-semibold truncate">Variants of this question</div>
                  <div className="text-xs muted truncate">{variantsFor.stem}</div>
                </div>
              </div>
              <button type="button"
                onClick={() => setVariantsFor(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded shrink-0"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5">
              {variantBusy ? (
                <div className="grid place-items-center py-12">
                  <div className="spinner" />
                  <div className="text-sm muted mt-3">Generating 3 isomorphic variants…</div>
                </div>
              ) : variantErr ? (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                  {variantErr}
                </div>
              ) : variantList.length === 0 ? (
                <div className="text-sm muted">No variants returned.</div>
              ) : (
                <div className="space-y-3">
                  <div className="text-xs muted flex items-center gap-1.5">
                    <Lightbulb size={12} /> Each variant tests the same concept with different surface details.
                  </div>
                  {variantList.map((v, i) => (
                    <div key={i} className="border border-slate-200 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <BloomBadge level={v.bloom_level} />
                        {v.topic && <span className="text-xs muted">{v.topic}</span>}
                        {v.verified && (
                          <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
                            verified
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-medium mb-2">{v.stem}</div>
                      <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        {v.options.map((o, oi) => (
                          <li key={oi} className={oi === v.correct_index ? "text-emerald-700 font-semibold" : "text-slate-600"}>
                            <span className="text-xs uppercase tracking-wide opacity-70 mr-1">
                              {String.fromCharCode(65 + oi)}.
                            </span>{o}
                            {oi === v.correct_index && (
                              <span className="ml-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700/80">✓ correct</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {v.explanation && (
                        <div className="text-xs muted mt-2"><strong>Why:</strong> {v.explanation}</div>
                      )}
                      <div className="mt-3 flex justify-end">
                        {variantSaved[i] ? (
                          <span className="text-xs font-semibold text-emerald-700 inline-flex items-center gap-1">
                            <Check size={14} /> Saved to bank
                          </span>
                        ) : (
                          <button type="button"
                            onClick={() => saveOneVariant(i)}
                            disabled={!!variantSaving[i]}
                            className="btn btn-secondary text-xs"
                          >
                            {variantSaving[i] ? <><span className="spinner" /> Saving…</> : <>Save to bank</>}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TopicChip({
  label, count, active, onClick,
}: {
  label: string; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium border transition ${
        active
          ? "border-emerald-500 bg-emerald-50 text-emerald-800"
          : "border-slate-300 text-slate-700 hover:bg-slate-50"
      }`}
    >
      {label}
      <span className={`ml-1 text-xs ${active ? "text-emerald-700" : "text-slate-500"}`}>({count})</span>
    </button>
  );
}

function BloomMiniChart({ items }: { items: Question[] }) {
  if (items.length === 0) return null;
  const counts = blankBloomCounts();
  items.forEach((q) => { counts[q.bloom_level]++; });
  const present = BLOOM_LEVELS.filter((l) => counts[l] > 0);
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 rounded-full overflow-hidden border border-slate-200 bg-slate-100">
        {BLOOM_LEVELS.map((l) => {
          const w = (counts[l] / items.length) * 100;
          if (w === 0) return null;
          return (
            <div
              key={l}
              style={{ width: `${w}%`, backgroundColor: BLOOM_META[l].color }}
              title={`${BLOOM_META[l].label}: ${counts[l]}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {present.map((l) => (
          <span key={l} className="flex items-center gap-1.5 text-slate-600">
            <span className="w-2.5 h-2.5 rounded" style={{ backgroundColor: BLOOM_META[l].color }} />
            {BLOOM_META[l].label} <span className="muted">{counts[l]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ClassFitCard({
  classes,
  targetClassId,
  setTargetClassId,
  fit,
  loading,
  hasSelection,
}: {
  classes: ClassOption[];
  targetClassId: string;
  setTargetClassId: (v: string) => void;
  fit: ClassFit | null;
  loading: boolean;
  hasSelection: boolean;
}) {
  const labelFor = (c: ClassOption) => {
    const parts = [c.name];
    if (c.section) parts.push(c.section);
    if (c.grade) parts.push(`Grade ${c.grade}`);
    return parts.filter(Boolean).join(" · ");
  };

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        <Users size={14} className="text-slate-400" />
        <h3 className="font-semibold text-sm">Will this fit a class?</h3>
        <span className="muted text-xs font-normal ml-auto">optional</span>
      </div>

      <select
        className="select w-full text-sm"
        value={targetClassId}
        onChange={(e) => setTargetClassId(e.target.value)}
      >
        <option value="">Compare with a class…</option>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {labelFor(c)}
          </option>
        ))}
      </select>

      {!targetClassId ? (
        <div className="text-xs muted mt-2">
          Pick a class to see how many of these questions they&apos;ve seen and how they did.
        </div>
      ) : !hasSelection ? (
        <div className="text-xs muted mt-2">
          Add at least one question to see fit.
        </div>
      ) : loading ? (
        <div className="text-xs muted mt-2 flex items-center gap-1.5">
          <span className="spinner" /> Checking…
        </div>
      ) : !fit ? (
        <div className="text-xs muted mt-2">No fit data right now.</div>
      ) : (
        <div className="mt-2 text-xs text-slate-700 space-y-1">
          {fit.matched === 0 ? (
            <div>
              This class hasn&apos;t seen any of the {fit.total} selected
              question{fit.total === 1 ? "" : "s"} yet — fresh territory.
            </div>
          ) : (
            <>
              <div>
                <strong className="text-slate-800">{fit.matched}</strong> of{" "}
                <strong className="text-slate-800">{fit.total}</strong> selected
                question{fit.total === 1 ? "" : "s"} have prior attempts in this class.
              </div>
              {fit.avg_score_pct !== null && (
                <div className="muted">
                  Average there: <strong className="text-slate-700">{fit.avg_score_pct}%</strong>{" "}
                  across {fit.attempts} attempt{fit.attempts === 1 ? "" : "s"}.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function NewQuizPage() {
  return (
    <Suspense fallback={<div className="grid place-items-center py-20"><div className="spinner" /></div>}>
      <ComposerInner />
    </Suspense>
  );
}
