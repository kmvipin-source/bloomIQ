"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, isBloomLevel, recommendedQuizMinutes, type BloomLevel } from "@/lib/bloom";
import type { Question } from "@/lib/types";
import { generateQuizCode } from "@/lib/utils";
import BloomBadge from "@/components/BloomBadge";
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

function ComposerInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [time, setTime] = useState(15);
  const [timeManuallySet, setTimeManuallySet] = useState(false);

  const [bank, setBank] = useState<Question[]>([]);
  const [loadingBank, setLoadingBank] = useState(true);
  const [bloomFilter, setBloomFilter] = useState<BloomLevel | "all">("all");
  const [topicFilter, setTopicFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
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
    if (topic) setTopicFilter(topic);
    if (bloom && (bloom === "all" || isBloomLevel(bloom))) {
      setBloomFilter(bloom as BloomLevel | "all");
    }
    if (q) setSearch(q);
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

  const topicCounts = useMemo(() => {
    const m = new Map<string, number>();
    bank.forEach((q) => {
      const k = topicKey(q.topic);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m, ([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  }, [bank]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return bank.filter((q) => {
      if (bloomFilter !== "all" && q.bloom_level !== bloomFilter) return false;
      if (topicFilter !== "all" && topicKey(q.topic) !== topicFilter) return false;
      if (needle) {
        const hay = `${q.stem} ${topicKey(q.topic)}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [bank, bloomFilter, topicFilter, search]);

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
      const ok = confirm(
        `This quiz spans ${selectedTopics.length} different topics:\n\n` +
        `  • ${selectedTopics.join("\n  • ")}\n\n` +
        `Did you intend to mix topics? Click OK to continue, or Cancel to revise.`
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in");

      let code = generateQuizCode();
      for (let i = 0; i < 4; i++) {
        const { data: existing } = await sb.from("quizzes").select("id").eq("code", code).maybeSingle();
        if (!existing) break;
        code = generateQuizCode();
      }

      const blooms = Array.from(new Set(selectedQuestions.map((q) => q.bloom_level)));
      let quizRow: { id: string } | null = null;
      const insertWithRecommended = await sb.from("quizzes").insert({
        owner_id: user.id,
        name,
        subject: subject.trim() || null,
        code,
        time_limit_minutes: time,
        recommended_minutes: recommendedMinutes || null,
        bloom_filter: blooms,
      }).select("id").single();
      if (insertWithRecommended.error) {
        if (/column.+recommended_minutes.+does not exist/i.test(insertWithRecommended.error.message)) {
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
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">Compose a test</h1>
          <p className="muted mt-1">Browse your library on the left, build the test on the right.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-sm muted">
            {bank.length} approved question{bank.length === 1 ? "" : "s"} in your library
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_400px] gap-6 mt-6 items-start">
        <section className="space-y-3">
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
            <button type="button" className="btn btn-secondary" onClick={addAllVisible} disabled={filtered.length === 0}>
              Add all visible
            </button>
            <span className="ml-auto text-xs muted whitespace-nowrap">{filtered.length} shown</span>
          </div>

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
            <div className="card text-center py-12 muted">No questions match these filters.</div>
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
          <div className="card">
            <label className="label">Test name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Photosynthesis Test" />
            <label className="label mt-3">Subject <span className="muted text-xs">(optional)</span></label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Science" />
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
                  <li key={q.id} className="p-3 rounded-lg border border-slate-200 bg-white">
                    <div className="flex items-start gap-2">
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

// ---------- Feature B: Class-fit suggestion card -----------------------
// Optional. Hidden entirely when the teacher has no classes. Collapses
// to a one-line dropdown when no class is selected, so it doesn't add
// noise to the create flow.
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
