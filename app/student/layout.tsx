"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import ZcoriqBloomScoreBadge from "@/components/ZcoriqBloomScoreBadge";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ok, setOk] = useState(false);

  // Hide sidebar inside the test interface for fewer distractions
  const taking = pathname.startsWith("/student/quiz/");

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { router.replace("/login?next=/student"); return; }

        // Finding #72 fix: same auth-race retry as /teacher/layout (Round 8
        // #53). Supabase auth-server eventual-consistency returns 401 for
        // ~300-800ms after sign-in; without the retry the layout falls
        // through to user_metadata.role (empty for school-onboarded
        // students) and the role-router redirects back to /login.
        let role = "";
        let platformAdmin = false;
        let meDataApplied = false;
        for (let attempt = 0; attempt < 3 && !meDataApplied; attempt++) {
        try {
          const r = await fetch("/api/auth/me", {
            headers: { Authorization: `Bearer ${session.access_token}` },
            cache: "no-store",
          });
          if (r.status === 401) {
            const j = await r.json().catch(() => ({}));
            if (j?.error === "session_superseded") {
              try { await sb.auth.signOut(); } catch { /* ignore */ }
              router.replace("/login?reason=elsewhere");
              return;
            }
            // Transient 401 — retry once after a short backoff.
            if (attempt < 2) {
              await new Promise((res) => setTimeout(res, 300));
              continue;
            }
          }
          if (r.ok) {
            meDataApplied = true;
            const j = await r.json();
            if (cancelled) return;
            role = String(j.role || "");
            platformAdmin = !!j.platform_admin;
            // Hard gate: if this student's auto-granted Free plan has expired,
            // every /student/* route except /student/expired itself is blocked.
            // Exact-match the expired path so any future sub-routes
            // under /student/expired/* don't accidentally satisfy the
            // "already at the gate" check.
            if (j.is_free_expired === true && pathname !== "/student/expired") {
              router.replace("/student/expired");
              return;
            }
            // ZCORIQ calibration is OPT-IN, not mandatory.
            //
            // Earlier versions of this layout hard-redirected any
            // independent student without a calibration row to
            // /student/bloom-score on every page load. That made
            // calibration feel like a wall between login and the rest
            // of the product, which it isn't — calibration is a
            // value-add the student can choose to take when they're
            // ready. We removed the gate per product direction
            // (Vipin, 2026-05-12).
            //
            // The polite reminder lives on:
            //   1. The /student dashboard "Discover your ZCORIQ Bloom Score"
            //      hero card — only renders when has_calibration ===
            //      false, so it disappears the moment they complete it.
            //   2. The ZcoriqBloomScoreBadge in this layout's top-right —
            //      renders a "Get your ZCORIQ →" CTA when uncalibrated,
            //      visible on every /student/* page.
            //
            // Both surfaces explain the benefit (3-digit indicative
            // readiness band tied to their goal + Bloom signature) so
            // the student keeps seeing the value proposition without
            // being forced into the flow.
          }
        } catch {
          // Finding #72 fix: retry on network blip same as on 401.
          if (attempt < 2) {
            await new Promise((res) => setTimeout(res, 300));
            continue;
          }
        }
        }  /* close auth-retry for-loop opened above */
        if (cancelled) return;
        if (!role) {
          const { data: { user } } = await sb.auth.getUser();
          role = String((user?.user_metadata as { role?: string } | undefined)?.role || "");
        }

        // platform_admin is exclusive — no hybrid display. Force them to /admin.
        if (platformAdmin)             { router.replace("/admin/onboard-school"); return; }
        // Send each role to its own home — never bounce a non-student back to /student
        if (role === "teacher")        { router.replace("/teacher"); return; }
        if (role === "super_teacher")  { router.replace("/school");  return; }
        if (role && role !== "student") { router.replace("/login");   return; }

        setOk(true);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[student layout] init failed", e);
        if (!cancelled) setOk(true);
      }
    }
    check();
    // Re-check on tab focus so a trial that expires mid-session — or a
    // session that gets superseded by sign-in on another device — is
    // caught without requiring a full reload. Reset `ok` to false so
    // children stop rendering with stale (potentially prior-user) data
    // while the new check runs; the spinner shows briefly until role
    // resolves again. Without this, the layout keeps mounting the old
    // student's UI under a new session until the bouncer fires.
    // Finding #74 fix: debounce focus events. Without this, rapid tab
    // toggles thrash the layout with N spinner-flashes + N /api/auth/me
    // fetches. Cap to one check every 5s.
    let lastFocusCheck = 0;
    function onFocus() {
      const now = Date.now();
      if (now - lastFocusCheck < 5000) return;
      lastFocusCheck = now;
      setOk(false);
      check();
    }
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
    // Re-fire on pathname change so route transitions re-evaluate the
    // trial-expiry + calibration gate.
  }, [pathname, router]);

  if (!ok) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }
  if (taking) return <main className="min-h-screen">{children}</main>;

  // Hide the score badge in surfaces where the score is already the
  // dominant element on the page or where the user is mid-calibration.
  const hideBadge =
    pathname === "/student/bloom-score" ||
    pathname.startsWith("/student/bloom-score/") ||
    pathname === "/student/future" ||
    pathname.startsWith("/student/future/");

  return (
    <div className="md:flex min-h-screen">
      <Sidebar role="student" />
      <MobileNav role="student" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">
        {!hideBadge ? (
          <div className="flex justify-end mb-3">
            <ZcoriqBloomScoreBadge />
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
