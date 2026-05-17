"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * /admin/* — internal ZCORIQ staff pages.
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
      const { data: { session } } = await sb.auth.getSession();
      // Bounce signed-out platform admins to the dedicated /staff
      // sign-in page (the public /login flow is for teachers/students
      // and doesn't expose the platform-admin tab). Drop the
      // next=onboard-school param so post-login lands on the canonical
      // /admin/dashboard rollup rather than the onboarding form.
      if (!session) { router.replace("/staff"); return; }

      // /api/auth/me uses the service-role client, so RLS lag on the
      // edge can't accidentally redirect a real platform admin to /.
      //
      // Finding #77 fix: same auth-race retry pattern as /student and
      // /teacher layouts. Supabase auth-server eventual-consistency
      // returns 401 for ~300-800ms after sign-in; without the retry,
      // a real platform admin gets bounced to / on their first sign-in.
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
          platformAdmin = !!j.platform_admin;
        }
      } catch {
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 300));
          continue;
        }
      }
      }
      if (!platformAdmin) { router.replace("/"); return; }
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
      <MobileNav role="platform_admin" />
      <main className="flex-1 p-4 md:p-8 overflow-auto">{children}</main>
    </div>
  );
}
