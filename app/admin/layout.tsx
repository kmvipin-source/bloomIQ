"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ShieldCheck } from "lucide-react";

/**
 * /admin/* — internal BloomIQ staff pages.
 *
 * Gated by profiles.platform_admin = true. There is intentionally no UI to
 * grant this flag; flip it manually in the Supabase SQL editor:
 *
 *   update public.profiles set platform_admin = true where id = '<uuid>';
 *
 * Any non-admin user who lands here is bounced to / so the page is invisible
 * to teachers, students, and Admin Heads.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { router.replace("/login?next=/admin/onboard-school"); return; }

      const { data: prof } = await sb
        .from("profiles")
        .select("platform_admin")
        .eq("id", user.id)
        .single();
      if (!prof?.platform_admin) { router.replace("/"); return; }
      setOk(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ok) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">BloomIQ</span>
            <span className="ml-2 text-xs uppercase tracking-wide font-bold text-white bg-slate-800 rounded px-2 py-0.5 inline-flex items-center gap-1">
              <ShieldCheck size={12} /> Admin
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/admin/onboard-school" className="text-slate-700 hover:text-emerald-700 font-medium">
              Onboard school
            </Link>
            <Link href="/admin/plans" className="text-slate-700 hover:text-emerald-700 font-medium">
              Plans
            </Link>
            <Link href="/admin/team" className="text-slate-700 hover:text-emerald-700 font-medium">
              Team
            </Link>
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto p-6">{children}</main>
    </div>
  );
}
