"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
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
          if (r.ok) {
            const j = await r.json();
            role = String(j.role || "");
            platformAdmin = !!j.platform_admin;
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
  return (
    <div className="md:flex min-h-screen">
      <Sidebar role="student" />
      <MobileNav role="student" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">{children}</main>
    </div>
  );
}
