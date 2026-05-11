"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;       // 30 min hard cap, all roles
const WARN_BEFORE_MS = 60 * 1000;              // 1-min "you'll be signed out" warning
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
const PROTECTED_PREFIXES = ["/student", "/teacher", "/school", "/admin", "/parent", "/settings", "/staff"];
const LAST_ACTIVITY_KEY = "bloomiq:last_activity";

/**
 * Client-side idle auto-sign-out — uniform 30-min cap across every
 * signed-in role.
 *
 * Three failure modes covered:
 *
 *   1. Active idle — user has the tab open but stops touching it.
 *      A rolling setTimeout fires signOut() at the cap.
 *   2. Backgrounded tab — browsers throttle setTimeout on hidden tabs
 *      (and pause it entirely once the laptop sleeps). When the tab
 *      becomes visible again we re-check wall-clock elapsed against
 *      lastActivity and force a signOut if we're past the cap.
 *   3. Cold start after closing the browser — the in-memory
 *      lastActivity ref is gone, but we persist the timestamp to
 *      localStorage on every bump. On mount, we read the persisted
 *      value FIRST; if the gap is over the cap we sign out before the
 *      dashboard finishes rendering. Without this check Supabase's
 *      long-lived refresh token would silently restore the session
 *      from yesterday.
 *
 * Mounted only on dashboard routes (PROTECTED_PREFIXES) so visitors
 * on /pricing / marketing / public help pages aren't bounced.
 */
export default function IdleSignOut() {
  const pathname = usePathname() || "";
  const router = useRouter();
  const lastActivityRef = useRef<number>(Date.now());
  const timerRef = useRef<number | null>(null);
  const warningRef = useRef<number | null>(null);

  const onProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  useEffect(() => {
    if (!onProtected) return;

    let signedOut = false;

    async function signOut() {
      if (signedOut) return;
      signedOut = true;
      try { window.localStorage.removeItem(LAST_ACTIVITY_KEY); } catch { /* ignore */ }
      try { await supabaseBrowser().auth.signOut(); } catch { /* ignore */ }
      // window.location.replace (not router.replace) so any in-memory
      // user state — including the Supabase client's cached session
      // and our PostHog identity — is wiped before the login form
      // mounts. Otherwise the next user could inherit the previous
      // session's identity until the next hard navigation.
      window.location.replace("/login?reason=idle");
    }

    // ----- Cold-start cross-session check -----
    // Run BEFORE we wire any listeners. If the persisted timestamp
    // says the user has been gone longer than the cap, sign out
    // immediately instead of letting them resume yesterday's session.
    try {
      const persisted = window.localStorage.getItem(LAST_ACTIVITY_KEY);
      if (persisted) {
        const last = parseInt(persisted, 10);
        if (Number.isFinite(last) && Date.now() - last >= IDLE_TIMEOUT_MS) {
          signOut();
          return;
        }
      }
    } catch { /* localStorage disabled — fall through to in-memory timer */ }

    function persist() {
      try { window.localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now())); } catch { /* ignore */ }
    }

    function bump() {
      lastActivityRef.current = Date.now();
      persist();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (warningRef.current) window.clearTimeout(warningRef.current);

      warningRef.current = window.setTimeout(() => {
        // Soft warning seam. A "stay signed in?" modal could hook in
        // here in future — today we just log.
        // eslint-disable-next-line no-console
        console.info("[idle] signing out in", Math.round(WARN_BEFORE_MS / 1000), "s");
      }, IDLE_TIMEOUT_MS - WARN_BEFORE_MS);

      timerRef.current = window.setTimeout(signOut, IDLE_TIMEOUT_MS);
    }

    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      // Catch the "browser was backgrounded longer than the cap"
      // case — setTimeout is throttled / paused on hidden tabs in
      // some browsers, so check elapsed wall-clock instead of trusting
      // the timer. Prefer the persisted timestamp over the in-memory
      // ref so a freshly-opened tab also benefits.
      let last = lastActivityRef.current;
      try {
        const persisted = window.localStorage.getItem(LAST_ACTIVITY_KEY);
        if (persisted) {
          const p = parseInt(persisted, 10);
          if (Number.isFinite(p)) last = Math.max(last, p);
        }
      } catch { /* ignore */ }
      if (Date.now() - last >= IDLE_TIMEOUT_MS) {
        signOut();
      } else {
        bump();
      }
    }

    bump();
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, bump);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (warningRef.current) window.clearTimeout(warningRef.current);
    };
  }, [onProtected, router]);

  return null;
}
