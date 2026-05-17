"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import RouteProgress from "@/components/RouteProgress";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SchoolLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.replace("/login?next=/school"); return; }

      // Finding #89 fix: 4th and final layout to receive the auth-race
      // retry treatment. Same shape as Rounds 8/16/17 for the
      // /teacher /student /admin layouts. Supabase auth-server eventual-
      // consistency returns 401 for ~300-800ms after sign-in; without
      // the retry, real super_teachers get bounced to /login on first
      // sign-in.
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
          if (attempt < 2) {
            await new Promise((res) => setTimeout(res, 300));
            continue;
          }
        }
        if (r.ok) {
          meDataApplied = true;
          const j = await r.json();
          role = String(j.role || "");
          platformAdmin = !!j.platform_admin;
        }
      } catch {
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 300));
          continue;
        }
      }
      }
      if (!role) {
        const { data: { user } } = await sb.auth.getUser();
        role = String((user?.user_metadata as { role?: string } | undefined)?.role || "");
      }

      // platform_admin is exclusive — no hybrid display. Force them to /admin.
      if (platformAdmin)            { router.replace("/admin/onboard-school"); return; }
      if (role === "teacher")       { router.replace("/teacher"); return; }
      if (role === "student")       { router.replace("/student"); return; }
      if (role !== "super_teacher") { router.replace("/login");   return; }

      setOk(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ok) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }
  return (
    <div className="md:flex min-h-screen">
      {/* Route progress bar — see /teacher/layout.tsx for rationale. */}
      <RouteProgress />
      <Sidebar role="super_teacher" />
      <MobileNav role="super_teacher" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">{children}</main>
    </div>
  );
}
