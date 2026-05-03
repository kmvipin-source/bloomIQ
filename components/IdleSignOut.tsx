"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;       // 30 min hard cap
const WARN_BEFORE_MS = 60 * 1000;              // 1-min "you'll be signed out" warning
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
const PROTECTED_PREFIXES = ["/student", "/teacher", "/school", "/admin", "/parent", "/settings"];

/**
 * Client-side idle auto-sign-out.
 *
 * Fires supabase.auth.signOut() + redirect to /login after
 * IDLE_TIMEOUT_MS without any user activity OR when the tab is
 * resumed and the last-activity timestamp is older than the cap.
 * The second check covers the "I closed my laptop overnight" case
 * — without it, the timer alone would keep firing setTimeouts that
 * a sleeping browser pauses.
 *
 * Only mounts on dashboard routes so a visitor on the marketing /
 * pricing pages isn't bounced.
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
      try { await supabaseBrowser().auth.signOut(); } catch { /* ignore */ }
      // Hard reload so any in-memory user state is wiped + the new
      // /login form starts clean.
      router.replace(`/login?reason=idle`);
    }

    function bump() {
      lastActivityRef.current = Date.now();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (warningRef.current) window.clearTimeout(warningRef.current);

      warningRef.current = window.setTimeout(() => {
        // Soft warning. We don't currently surface a banner; this hook
        // is the seam if a future "stay signed in?" modal is added.
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
      // the timer.
      if (Date.now() - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
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
