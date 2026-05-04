"use client";

import { useEffect } from "react";

/**
 * Calls `fn` whenever the tab regains focus or becomes visible. Pages that
 * depend on server state (rosters, invite statuses, attempt counts) use this
 * so that switching back to the tab after another user took an action
 * elsewhere refreshes the view without forcing a manual reload.
 *
 * Pass a stable function (useCallback or a top-level reference). The hook
 * intentionally does not depend on `fn` in the effect array — re-binding
 * listeners on every render would churn DOM events. The latest `fn` is
 * captured via closure on each render, so this is fine in practice.
 */
export function useFocusRefetch(fn: () => void | Promise<void>) {
  useEffect(() => {
    const onFocus = () => { void fn(); };
    const onVisible = () => {
      if (document.visibilityState === "visible") void fn();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
