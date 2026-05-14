"use client";

// components/GenerateContextChips.tsx — fully optional context block.
// Three controls, all optional:
//   1. Audience level — Beginner / Practitioner / Expert. Defaults to NONE
//      (the user can leave it unset; the backend then sends no audience
//      fragment to the LLM and lets the model use its own judgment).
//   2. Auto-suggested sub-topic chips via /api/generate/subtopics.
//   3. "Anything specific to cover?" textbox with smart placeholder
//      + inline off-topic warning.

import { useEffect, useState, useRef } from "react";
import { GraduationCap, Sparkles, Info } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { smartTopicPlaceholder, validateFocusForTopic } from "@/lib/topicEnrichment";
import type { AudienceLevel } from "@/lib/audienceLevel";

export type GenerateContext = {
  audience_level: AudienceLevel | null;
  sub_topics: string[];
  additional_focus: string;
};

type Props = {
  topic: string;
  /** Kept for API back-compat; ignored now that the chip is fully optional. */
  defaultAudienceLevel?: AudienceLevel | null;
  onChange: (next: GenerateContext) => void;
  disabled?: boolean;
  initialFocus?: string;
};

const AUDIENCE_OPTIONS: { value: AudienceLevel; label: string; blurb: string }[] = [
  { value: "beginner",     label: "Beginner",     blurb: "Plain language. Single-step questions. Class 9-12 / new to topic." },
  { value: "practitioner", label: "Practitioner", blurb: "Working knowledge. Multi-step + real scenarios. JEE / NEET / CAT / corporate." },
  { value: "expert",       label: "Expert",       blurb: "Edge cases, subtle distinctions, debugging-style framings." },
];

export default function GenerateContextChips({
  topic,
  onChange,
  disabled,
  initialFocus,
}: Props) {
  // Audience defaults to null — explicit "no preference". User can toggle a
  // level on; clicking it again clears back to null. Skip the section
  // entirely if you don't care.
  const [audience, setAudience] = useState<AudienceLevel | null>(null);
  const [suggestedChips, setSuggestedChips] = useState<string[]>([]);
  const [selectedChips, setSelectedChips] = useState<string[]>([]);
  const [extra, setExtra] = useState(initialFocus || "");
  const [loadingChips, setLoadingChips] = useState(false);
  const [chipNote, setChipNote] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);
  const debouncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onChange({ audience_level: audience, sub_topics: selectedChips, additional_focus: extra });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, selectedChips, extra]);

  useEffect(() => {
    if (debouncedTimer.current) clearTimeout(debouncedTimer.current);
    if (!topic || topic.trim().length < 3) {
      setSuggestedChips([]);
      setSelectedChips([]);
      setChipNote(null);
      return;
    }
    debouncedTimer.current = setTimeout(() => { void fetchSubtopics(topic.trim()); }, 500);
    return () => { if (debouncedTimer.current) clearTimeout(debouncedTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);

  async function fetchSubtopics(t: string) {
    const seq = ++fetchSeqRef.current;
    setLoadingChips(true);
    setChipNote(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const r = await fetch("/api/generate/subtopics", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ topic: t }),
      });
      if (seq !== fetchSeqRef.current) return;
      const j = await r.json();
      const subs: string[] = Array.isArray(j.subtopics) ? j.subtopics : [];
      setSuggestedChips(subs);
      // Do NOT pre-select — let the user opt in. Keeps the whole block optional.
      setSelectedChips([]);
      if (subs.length === 0 && j.warning === "llm_unavailable") {
        setChipNote("Suggestions unavailable right now.");
      }
    } catch {
      // silent
    } finally {
      if (seq === fetchSeqRef.current) setLoadingChips(false);
    }
  }

  function toggleAudience(v: AudienceLevel) {
    // Click the currently-active chip to clear it. Click any other to switch.
    setAudience((prev) => (prev === v ? null : v));
  }
  function toggleChip(chip: string) {
    setSelectedChips((prev) => prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]);
  }

  const placeholder = smartTopicPlaceholder(topic);
  const focusValidation = extra.trim().length > 0
    ? validateFocusForTopic(topic, extra, selectedChips)
    : { ok: true as const };
  const focusOffTopic = focusValidation.ok === false;
  const anySectionUsed = audience !== null || selectedChips.length > 0 || extra.trim().length > 0;

  return (
    <div className="space-y-3 mt-3 p-3 rounded-lg border border-slate-200 bg-slate-50/50">
      {/* Optional-banner intro so the user knows nothing here is required */}
      <div className="text-[12px] muted italic">
        Everything in this section is <strong>optional</strong>. Use these only if you want
        more control over depth, breadth, or angle. {anySectionUsed ? "" : "Leave them alone to let the AI pick."}
      </div>

      {/* Audience-level chip row — 4-state (none/begin/prac/expert) */}
      <div>
        <div className="flex items-center gap-1.5 text-xs uppercase font-semibold muted mb-1.5">
          <GraduationCap size={12} /> Question depth <span className="text-slate-400 normal-case italic">(optional)</span>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {AUDIENCE_OPTIONS.map((opt) => {
            const active = audience === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                onClick={() => toggleAudience(opt.value)}
                title={opt.blurb}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? "bg-emerald-600 text-white border-emerald-700"
                    : "bg-white text-slate-700 border-slate-300 hover:border-emerald-500 hover:text-emerald-700"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {opt.label}
              </button>
            );
          })}
          {audience !== null && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setAudience(null)}
              className="px-2 py-1 rounded-full text-xs text-slate-500 hover:text-slate-800 underline"
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-[11px] muted mt-1 italic">
          {audience === null
            ? "Not set — the AI will write a balanced mix. Click a level only if you want to bias it."
            : AUDIENCE_OPTIONS.find((o) => o.value === audience)?.blurb}
        </p>
      </div>

      {/* Auto-suggested sub-topic chips */}
      {(loadingChips || suggestedChips.length > 0 || chipNote) && (
        <div>
          <div className="flex items-center gap-1.5 text-xs uppercase font-semibold muted mb-1.5">
            <Sparkles size={12} /> Suggested coverage <span className="text-slate-400 normal-case italic">(optional)</span>
            {loadingChips && <span className="muted normal-case text-[11px] italic">(suggesting...)</span>}
          </div>
          {suggestedChips.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {suggestedChips.map((chip) => {
                const active = selectedChips.includes(chip);
                return (
                  <button
                    key={chip}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleChip(chip)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      active
                        ? "bg-amber-100 text-amber-900 border-amber-400"
                        : "bg-white text-slate-600 border-slate-300 hover:border-amber-400 hover:text-amber-700"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {active ? "✓ " : ""}{chip}
                  </button>
                );
              })}
              {selectedChips.length > 0 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelectedChips([])}
                  className="px-2 py-1 rounded-full text-xs text-slate-500 hover:text-slate-800 underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}
          {chipNote && (
            <p className="text-[11px] muted mt-1 italic flex items-center gap-1">
              <Info size={11} /> {chipNote}
            </p>
          )}
          {suggestedChips.length > 0 && (
            <p className="text-[11px] muted mt-1 italic">
              {selectedChips.length === 0
                ? "Not set — questions will cover the whole topic without bias. Click chips only if you want specific coverage."
                : "Questions will be distributed across the highlighted chips."}
            </p>
          )}
        </div>
      )}

      {/* "More instructions" textbox. Upgraded 2026-05-14 from a single-line
          input → multi-line textarea so students can write natural-language
          requests like "test absorption mechanisms in detail with clinical
          scenarios" instead of forcing them into chip-style fragments. The
          backend (lib/topicEnrichment.applyAdditionalFocus) now branches on
          length: short input (≤150 chars) keeps the legacy "sub-area" framing;
          longer input is wrapped as explicit STUDENT INSTRUCTIONS in the
          prompt so phrases like "tough questions" survive. Difficulty itself
          flows through Bloom levels — we surface that hint inline below. */}
      <div>
        <label className="flex items-center gap-1.5 text-xs uppercase font-semibold muted mb-1.5">
          More instructions <span className="text-slate-400 normal-case italic">(optional)</span>
        </label>
        <textarea
          className="input text-sm"
          rows={3}
          placeholder={placeholder}
          value={extra}
          maxLength={800}
          disabled={disabled}
          onChange={(e) => setExtra(e.target.value)}
        />
        {extra.trim().length > 0 && extra.trim().length <= 150 && selectedChips.length > 0 && !focusOffTopic && (
          <p className="text-[11px] muted mt-1 italic">
            Treated as one more sub-area — questions distribute evenly across your {selectedChips.length} chip{selectedChips.length === 1 ? "" : "s"} + this angle.
          </p>
        )}
        {extra.trim().length > 0 && extra.trim().length <= 150 && selectedChips.length === 0 && !focusOffTopic && (
          <p className="text-[11px] muted mt-1 italic">
            All questions will focus on this angle (within the main topic).
          </p>
        )}
        {extra.trim().length > 150 && !focusOffTopic && (
          <p className="text-[11px] muted mt-1 italic">
            Sent to the AI as explicit instructions. For tougher questions, also pick <strong>Analyze</strong> / <strong>Evaluate</strong> / <strong>Create</strong> Bloom levels above — this box is for <em>what</em> to cover, not <em>how hard</em>.
          </p>
        )}
        {extra.length > 700 && (
          <p className="text-[11px] muted mt-1 italic">{800 - extra.length} characters left.</p>
        )}
        {focusOffTopic && focusValidation.ok === false && (
          <div className="mt-2 rounded-md bg-amber-50 border border-amber-300 px-2.5 py-2 text-[12px] text-amber-900 flex items-start gap-1.5">
            <Info size={12} className="mt-0.5 shrink-0" />
            <div>
              <strong>Heads up:</strong> {focusValidation.reason}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
