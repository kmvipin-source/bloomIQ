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
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { router.replace("/login?next=/school"); return; }

      const { data: prof } = await sb
        .from("profiles")
        .select("role, platform_admin")
        .eq("id", user.id)
        .maybeSingle();

      const metaRole = String((user.user_metadata as { role?: string } | undefined)?.role || "");
      const role = prof?.role || metaRole;

      // platform_admin is exclusive — no hybrid display. Force them to /admin.
      if (prof?.platform_admin)     { router.replace("/admin/onboard-school"); return; }
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
