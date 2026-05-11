"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `fn` whenever the tab regains focus or becomes visible. Pages that
 * depend on server state (rosters, invite statuses, attempt counts) use this
 * so that switching back to the tab after another user took an action
 * elsewhere refreshes the view without forcing a manual reload.
 *
 * Uses a ref to track the latest `fn` so callers can pass an inline
 * function without re-binding the DOM listeners on every render. The
 * previous implementation captured `fn` only on first render (deps `[]`),
 * which silently called a stale version forever for callers that didn't
 * useCallback the function. The ref pattern fixes that without churning
 * event listeners.
 */
export function useFocusRefetch(fn: () => void | Promise<void>) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);

  useEffect(() => {
    const onFocus = () => { void fnRef.current(); };
    const onVisible = () => {
      if (document.visibilityState === "visible") void fnRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
