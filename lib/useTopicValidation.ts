// lib/useTopicValidation.ts
// =============================================================================
// Shared topic-validation hook (P3.12).
// -----------------------------------------------------------------------------
// Why
// ---
// Five generation surfaces (student/generate, teacher/generate, speed,
// flashcards, teach-back) each implement their own 800ms-debounced call
// to /api/topic-validate. They've drifted:
//   - student/generate retries on network error; flashcards doesn't
//   - speed adds a 5s timeout; teach-back has no timeout
//   - teacher/generate caches the last 5 topic strings; others don't
// One hook, one behaviour everywhere.
//
// Posture
// -------
// - Fail open: any network or parse error treats the topic as VALID.
//   Topic validation is a UX nicety, not a security check; the server
//   re-validates anyway.
// - AbortController per-keystroke: a slow response for "phot" must NOT
//   overwrite the fresh response for "photosynthesis".
// - 800ms debounce matches existing surfaces so the migration is
//   imperceptible.
// =============================================================================

"use client";

import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export type TopicValidationVerdict = {
  /** True when the topic looks valid (default state until proven otherwise). */
  ok: boolean;
  /** Server-supplied reason when ok=false. */
  reason: string | null;
  /** Loading state — useful for spinners next to the input. */
  validating: boolean;
};

const DEBOUNCE_MS = 800;
const REQUEST_TIMEOUT_MS = 5000;
/** Topics this short are treated as "still typing" and skipped. Matches
 *  existing behaviour on student/generate where the validator was a
 *  no-op below 3 chars. */
const MIN_LENGTH = 3;

const LRU_CACHE = new Map<string, { ok: boolean; reason: string | null }>();
const LRU_MAX = 40;

function lruGet(key: string) {
  const v = LRU_CACHE.get(key);
  if (!v) return undefined;
  // Touch — move to most-recently-used end.
  LRU_CACHE.delete(key);
  LRU_CACHE.set(key, v);
  return v;
}
function lruSet(key: string, v: { ok: boolean; reason: string | null }) {
  if (LRU_CACHE.has(key)) LRU_CACHE.delete(key);
  LRU_CACHE.set(key, v);
  while (LRU_CACHE.size > LRU_MAX) {
    // Delete the oldest (insertion-order iteration).
    const first = LRU_CACHE.keys().next().value;
    if (!first) break;
    LRU_CACHE.delete(first);
  }
}

export type UseTopicValidationOptions = {
  /** Optional teaching context to scope the validation (e.g. "JEE" vs
   *  "Class 5-8" — "tcp/ip" is fine for JEE-CS but suspect for Class 5).
   *  Passed through to /api/topic-validate?context=... */
  context?: string | null;
  /** Disable validation (e.g. when the user is using a non-text input
   *  like an upload). */
  disabled?: boolean;
};

/**
 * Debounced topic validator with an in-memory LRU cache and per-keystroke
 * abort. Drop-in for the five generation surfaces.
 *
 * Usage:
 *   const v = useTopicValidation(topic, { context: examGoal });
 *   if (!v.ok && !v.validating) showWarning(v.reason);
 */
export function useTopicValidation(
  topic: string,
  options: UseTopicValidationOptions = {},
): TopicValidationVerdict {
  const [state, setState] = useState<TopicValidationVerdict>({
    ok: true,
    reason: null,
    validating: false,
  });
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (options.disabled) {
      setState({ ok: true, reason: null, validating: false });
      return;
    }
    const t = (topic || "").trim();
    if (t.length < MIN_LENGTH) {
      setState({ ok: true, reason: null, validating: false });
      return;
    }
    const cacheKey = `${t.toLowerCase()}|${(options.context || "").toLowerCase()}`;
    const cached = lruGet(cacheKey);
    if (cached) {
      setState({ ok: cached.ok, reason: cached.reason, validating: false });
      return;
    }

    // Schedule the debounced call.
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setState((prev) => ({ ...prev, validating: true }));

    timeoutRef.current = setTimeout(async () => {
      // Cancel any in-flight request from a prior keystroke.
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) {
          // Unauthenticated — let the server gate. Treat as valid.
          setState({ ok: true, reason: null, validating: false });
          return;
        }
        const url = new URL("/api/topic-validate", window.location.origin);
        url.searchParams.set("topic", t);
        if (options.context) url.searchParams.set("context", options.context);
        const r = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!r.ok) {
          // Server error — fail open.
          setState({ ok: true, reason: null, validating: false });
          return;
        }
        const j = (await r.json()) as { ok?: boolean; reason?: string };
        const verdict = { ok: j.ok !== false, reason: j.reason || null };
        lruSet(cacheKey, verdict);
        setState({ ...verdict, validating: false });
      } catch {
        // Aborted or network error — fail open.
        setState({ ok: true, reason: null, validating: false });
      } finally {
        clearTimeout(timer);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [topic, options.context, options.disabled]);

  return state;
}
