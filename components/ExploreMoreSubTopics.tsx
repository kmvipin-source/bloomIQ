"use client";

// components/ExploreMoreSubTopics.tsx
// -----------------------------------------------------------------------------
// Phase 4 of the 2026-05-13 generate-context-v2 rollout: after a student
// finishes a quiz, surface the OTHER sub-areas of the quiz's topic that
// they could explore next. Click a chip → jump to /student/generate with
// the topic pre-filled + that sub-area injected into the additional_focus
// hint. Converts a one-shot generation into an exploration flow.
//
// Pure UI — no LLM calls of its own (uses the cached
// /api/generate/subtopics route). Renders nothing if:
//   * the quiz has no topic / subject
//   * the subtopics endpoint returns empty
//   * the user is a school student (per parent gate)
//
// Designed to drop into /student/results/[id]/page.tsx with a single
// import + one line of JSX.
// =============================================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Props = {
  /** The quiz's subject (preferred) or name — whatever carries the topic. */
  topic: string | null | undefined;
};

export default function ExploreMoreSubTopics({ topic }: Props) {
  const [chips, setChips] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = (topic || "").trim();
    if (!t || t.length < 3) {
      setChips([]);
      setLoaded(true);
      return;
    }
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session || cancelled) { setLoaded(true); return; }
        const r = await fetch("/api/generate/subtopics", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ topic: t }),
        });
        const j = await r.json();
        if (cancelled) return;
        const subs: string[] = Array.isArray(j.subtopics) ? j.subtopics : [];
        setChips(subs);
      } catch {
        // Silent — this section is purely additive.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [topic]);

  // Hide entirely when we have no chips. Don't render an empty header.
  if (!loaded || chips.length === 0) return null;
  const safeTopic = (topic || "").trim();

  return (
    <div className="card mt-4">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={18} className="text-amber-700" />
        <h3 className="h2">Explore more of this topic</h3>
      </div>
      <p className="text-sm muted mb-3">
        Want more practice on <strong>{safeTopic}</strong>? Pick a sub-area below — we&apos;ll generate a fresh test focused on it.
      </p>
      <div className="flex gap-2 flex-wrap">
        {chips.map((chip) => {
          // Pre-fill /student/generate with the topic + sub-area hint.
          const href = `/student/generate?topic=${encodeURIComponent(safeTopic)}&prefill_chip=${encodeURIComponent(chip)}`;
          return (
            <Link
              key={chip}
              href={href}
              className="px-3 py-1.5 rounded-full text-xs font-medium border border-amber-300 bg-amber-50/60 text-amber-900 hover:bg-amber-100 hover:border-amber-500 transition-colors"
            >
              {chip} →
            </Link>
          );
        })}
      </div>
      <p className="text-[11px] muted mt-2 italic">
        Suggestions are auto-detected and cached — same chips for everyone, so they&apos;re fast on second visit.
      </p>
    </div>
  );
}
