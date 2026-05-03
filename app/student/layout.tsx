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
        const { data: { user } } = await sb.auth.getUser();
        if (!user) { router.replace("/login?next=/student"); return; }

        const { data: prof, error: profErr } = await sb
          .from("profiles")
          .select("role, platform_admin")
          .eq("id", user.id)
          .maybeSingle();
        if (profErr) {
          // RLS or connectivity hiccup — don't trap the user on a spinner.
          // eslint-disable-next-line no-console
          console.error("[student layout] profile lookup failed", profErr);
          setOk(true);
          return;
        }

        // platform_admin is exclusive — no hybrid display. Force them to /admin.
        if (prof?.platform_admin)           { router.replace("/admin/onboard-school"); return; }
        // Send each role to its own home — never bounce a non-student back to /student
        if (prof?.role === "teacher")       { router.replace("/teacher"); return; }
        if (prof?.role === "super_teacher") { router.replace("/school");  return; }
        if (prof && prof.role !== "student") { router.replace("/login");   return; }

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
