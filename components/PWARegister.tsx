"use client";

import { useEffect } from "react";

/**
 * Registers the service worker once the page has loaded. Silent failure on
 * unsupported browsers / non-HTTPS contexts other than localhost.
 */
export default function PWARegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // === Dev-mode safety net ===========================================
    // Service workers are HORRIBLE in dev — they cache stale chunks and
    // make navigation flaky. In production we register; in dev we
    // proactively UNREGISTER any existing service worker that survived
    // from a previous session, so clicks never get intercepted.
    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => { r.unregister().catch(() => {}); });
      }).catch(() => {});
      return;
    }

    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}
