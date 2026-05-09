"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import BloomIQScoreBadge from "@/components/BloomIQScoreBadge";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ok, setOk] = useState(false);

  // Hide sidebar inside the test interface for fewer distractions
  const taking = pathname.startsWith("/student/quiz/");

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { router.replace("/login?next=/student"); return; }

        let role = "";
        let platformAdmin = false;
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
          }
          if (r.ok) {
            const j = await r.json();
            role = String(j.role || "");
            platformAdmin = !!j.platform_admin;
            // Hard gate: if this student's auto-granted Free plan has expired,
            // every /student/* route except /student/expired itself is blocked.
            if (j.is_free_expired === true && !pathname.startsWith("/student/expired")) {
              router.replace("/student/expired");
              return;
            }
          }
        } catch { /* fall through */ }
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
        setOk(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            <BloomIQScoreBadge />
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
