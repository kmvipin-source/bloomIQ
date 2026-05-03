"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SchoolLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.replace("/login?next=/school"); return; }

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
      <Sidebar role="super_teacher" />
      <MobileNav role="super_teacher" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">{children}</main>
    </div>
  );
}
