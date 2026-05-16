"use client";
// F121 note (QA): this page surfaced as an audit gap (Phase 6). Quick
// re-audit checklist:
//   1. Confirm the data query respects student-scoped RLS.
//   2. Pagination / empty state for new students.
//   3. Tab-close / navigation doesn't lose filter state.
//   4. PostHog event when a student opens a library item.
// F121 note (QA): this page surfaced as an audit gap (Phase 6). Quick
// re-audit checklist:
//   1. Confirm the data query respects student-scoped RLS.
//   2. Pagination / empty state for new students.
//   3. Tab-close / navigation doesn't lose filter state.
//   4. PostHog event when a student opens a library item.

// app/student/library/page.tsx
// =============================================================================
// Student question library (P1.7).
// -----------------------------------------------------------------------------
// Browse, filter, and re-use questions you've generated. Mirrors the
// teacher review/browse UX in spirit but is scoped to the student's own
// rows via RLS + an explicit owner_id filter on /api/student/library.
//
// Scope of this initial drop:
//   ✓ List with filters (topic, Bloom, category, free-text)
//   ✓ Pagination
//   ✓ Per-card "re-quiz from this set" button (drops into student/generate
//     with the topic + Bloom pre-filled)
//   — Favorite/star + per-question attempt-history drilldown (deferred —
//     additive, needs a new favorites table; see follow-up plan)
//
// All copy is intentionally short — a library page should feel like a
// reference, not a sales page.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { categoryLabel } from "@/lib/questionCategory";
import type { Question } from "@/lib/types";

type LibraryResponse = {
  ok: boolean;
  items: Question[];
  total: number;
  limit: number;
  offset: number;
};

const PAGE_SIZE = 30;

export default function StudentLibraryPage() {
  const [items, setItems] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);

  // Filters
  const [topic, setTopic] = useState("");
  const [bloom, setBloom] = useState<BloomLevel | "">("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");

  async function load(nextOffset = 0) {
    setLoading(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        setItems([]);
        setTotal(0);
        return;
      }
      const url = new URL("/api/student/library", window.location.origin);
      if (topic) url.searchParams.set("topic", topic);
      if (bloom) url.searchParams.set("bloom", bloom);
      if (category) url.searchParams.set("category", category);
      if (q) url.searchParams.set("q", q);
      url.searchParams.set("sort", sort);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(nextOffset));

      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!r.ok) {
        setItems([]);
        setTotal(0);
        return;
      }
      const j = (await r.json()) as LibraryResponse;
      setItems(j.items || []);
      setTotal(j.total || 0);
      setOffset(j.offset || 0);
    } finally {
      setLoading(false);
    }
  }

  // Initial load + reload on filter change (debounced for free-text).
  useEffect(() => {
    const handle = setTimeout(() => { load(0); }, q || topic ? 350 : 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, bloom, category, q, sort]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // Distinct topics/categories within the loaded page — for filter chips.
  // (Server-side group-by is the next iteration; this page-scoped version
  // is enough to be useful with no extra DB call.)
  const visibleCategories = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.category) set.add(it.category);
    return Array.from(set);
  }, [items]);

  return (
    <main className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-1">My question library</h1>
      <p className="text-sm text-slate-500 mb-6">
        Every question you've generated, in one place. Filter, search, and
        re-quiz yourself on any subset.
      </p>

      {/* Filters */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <input
          className="input"
          placeholder="Search question text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="input"
          placeholder="Topic contains…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <select
          className="select"
          value={bloom}
          onChange={(e) => setBloom(e.target.value as BloomLevel | "")}
        >
          <option value="">Any Bloom level</option>
          {BLOOM_LEVELS.map((l) => (
            <option key={l} value={l}>{BLOOM_META[l].label}</option>
          ))}
        </select>
        <select
          className="select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Any category</option>
          {visibleCategories.map((c) => (
            <option key={c} value={c}>{categoryLabel(c)}</option>
          ))}
        </select>
      </section>

      <div className="flex items-center justify-between mb-4 text-sm">
        <span className="text-slate-500">
          {loading ? "Loading…" : `${total} question${total === 1 ? "" : "s"}`}
        </span>
        <label className="text-slate-500">
          Sort:{" "}
          <select
            className="select inline-block"
            value={sort}
            onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>

      {/* List */}
      {items.length === 0 && !loading && (
        <div className="rounded-lg border border-slate-200 p-8 text-center text-slate-500">
          <p className="mb-2 font-medium">Nothing in your library yet.</p>
          <p className="text-sm">
            Generate a quiz from the <Link className="link" href="/student/generate">Generate page</Link> and
            it'll show up here for re-use.
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((q2) => (
          <li key={q2.id} className="card">
            <div className="flex items-center gap-2 mb-2">
              <span className={`badge badge-${q2.bloom_level}`}>
                {BLOOM_META[q2.bloom_level].label}
              </span>
              {q2.category && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                  {categoryLabel(q2.category)}
                </span>
              )}
              {q2.topic && (
                <span className="text-xs text-slate-500 ml-auto">{q2.topic}</span>
              )}
            </div>
            <p className="text-sm font-medium text-slate-800 mb-2">{q2.stem}</p>
            <ol className="text-sm text-slate-600 list-[upper-alpha] ml-6 space-y-1">
              {q2.options.map((o, i) => (
                <li
                  key={i}
                  className={i === q2.correct_index ? "font-semibold text-emerald-700" : ""}
                >
                  {o}
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-end mt-3 gap-2">
              <Link
                href={`/student/generate?topic=${encodeURIComponent(q2.topic || "")}&bloom=${q2.bloom_level}`}
                className="btn btn-secondary text-xs"
              >
                Re-quiz on this topic
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-6">
          <button
            type="button"
            className="btn btn-secondary text-sm"
            disabled={offset <= 0 || loading}
            onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Previous
          </button>
          <span className="text-sm text-slate-500">
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => load(offset + PAGE_SIZE)}
          >
            Next →
          </button>
        </div>
      )}
    </main>
  );
}
