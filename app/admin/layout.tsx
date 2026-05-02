"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * /admin/* — internal BloomIQ staff pages.
 *
 * Gated by profiles.platform_admin = true. Anyone without the flag
 * is bounced to /. Bootstrap admin must be flipped via SQL once;
 * everyone else is granted from /admin/team.
 *
 * Visual shell: same left-sidebar pattern as teacher / student /
 * super-teacher (Sidebar component, role="platform_admin"). Switching
 * roles within the same physical machine now feels consistent — same
 * theme picker, same Profile / Help / Security / Sign out at the
 * bottom, same hover behaviour.
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
    return (
      <div className="min-h-screen grid place-items-center" style={{ background: "var(--color-bg)" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar role="platform_admin" />
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  );
}
