"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
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
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { router.replace("/login?next=/teacher"); return; }

      const { data: prof } = await sb
        .from("profiles")
        .select("role, platform_admin, school_id")
        .eq("id", user.id)
        .maybeSingle();

      // Profile RLS race fallback — read role from auth metadata so a
      // transient null doesn't bounce a teacher off their own dashboard.
      const metaRole = String((user.user_metadata as { role?: string } | undefined)?.role || "");
      const role = prof?.role || metaRole;

      // platform_admin is exclusive — no hybrid display. Force them to /admin.
      if (prof?.platform_admin)           { router.replace("/admin/onboard-school"); return; }
      // Each role has exactly one home — no ping-pong between layouts.
      if (role === "student")       { router.replace("/student"); return; }
      if (role === "super_teacher") { router.replace("/school");  return; }
      if (role !== "teacher")       { router.replace("/login");   return; }

      // School-membership gate: any sub-route is blocked until they join.
      // The home page itself shows the join card, so we let it through.
      const isHome = pathname === "/teacher" || pathname === "/teacher/";
      if (!prof?.school_id && !isHome) {
        router.replace("/teacher");
        return;
      }

      setOk(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (!ok) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }
  return (
    <div className="md:flex min-h-screen">
      <Sidebar role="teacher" />
      <MobileNav role="teacher" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">{children}</main>
    </div>
  );
}
