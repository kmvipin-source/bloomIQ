"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import RouteProgress from "@/components/RouteProgress";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * Teacher layout — auth + role + school-membership gate.
 *
 * Two checks layered together:
 *   1. Auth + role: must be signed in AND have role='teacher'. Other
 *      roles are bounced to their own home; platform admins to /admin.
 *   2. School membership: a teacher with school_id = null hasn't been
 *      onboarded into a school yet. Without a school there's no plan,
 *      and feature gating is a no-op — they could otherwise hit any
 *      /teacher/* URL directly and use everything for free. So we
 *      redirect every sub-route (/teacher/quizzes, /teacher/live, etc)
 *      back to /teacher home, where the dashboard renders ONLY the
 *      "Join your school" card and suppresses everything else.
 *
 *      The /teacher home page is itself allowed to render with no
 *      school — the join CTA needs to be reachable.
 */
export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (cancelled) return;
      if (!session) { router.replace("/login?next=/teacher"); return; }

      // Service-role lookup — sidesteps the user-token RLS race that
      // wrongly redirected real teachers to /student or /admin.
      //
      // Finding #53 fix: a transient 401 from /api/auth/me (Supabase's
      // auth-server eventual-consistency delay right after sign-in) was
      // falling straight through to the user_metadata fallback, which is
      // empty for school-onboarded teachers — so role stayed "" and the
      // role-router bounced them back to /login. Retry the call 2 more
      // times with a short backoff before giving up. Empirically clears
      // the first-time-login race almost entirely.
      let role = "";
      let platformAdmin = false;
      let schoolId: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
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
            // Transient 401 from auth-server race — retry once after a short
            // backoff before giving up.
            if (attempt < 2) {
              await new Promise((res) => setTimeout(res, 300));
              continue;
            }
          }
          if (r.ok) {
            const j = await r.json();
            role = String(j.role || "");
            platformAdmin = !!j.platform_admin;
            schoolId = j.school_id || null;
            break;
          }
        } catch {
          // Network blip — same retry handling as 401.
          if (attempt < 2) {
            await new Promise((res) => setTimeout(res, 300));
            continue;
          }
        }
        break;
      }
      if (!role) {
        const { data: { user } } = await sb.auth.getUser();
        role = String((user?.user_metadata as { role?: string } | undefined)?.role || "");
      }

      // platform_admin is exclusive — no hybrid display. Force them to /admin.
      if (platformAdmin)            { router.replace("/admin/onboard-school"); return; }
      // Each role has exactly one home — no ping-pong between layouts.
      if (role === "student")       { router.replace("/student"); return; }
      if (role === "super_teacher") { router.replace("/school");  return; }
      if (role !== "teacher")       { router.replace("/login");   return; }

      // School-membership gate: any sub-route is blocked until they join.
      // The home page itself shows the join card, so we let it through.
      const isHome = pathname === "/teacher" || pathname === "/teacher/";
      if (!schoolId && !isHome) {
        router.replace("/teacher");
        return;
      }

      if (cancelled) return;
      setOk(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (!ok) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }
  return (
    <div className="md:flex min-h-screen">
      {/* Route progress bar — gives instant visual feedback on every
          sidebar / link click so dev-mode JIT compilation latency
          doesn't read as "click didn't work, click again". */}
      <RouteProgress />
      <Sidebar role="teacher" />
      <MobileNav role="teacher" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">{children}</main>
    </div>
  );
}
