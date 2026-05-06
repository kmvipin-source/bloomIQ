"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LogOut, LayoutDashboard } from "lucide-react";

/**
 * PublicNav — top-of-page navigation for the public marketing pages
 * (/, /pricing, etc).
 *
 * Auth-aware: when the visitor is NOT logged in, it shows the standard
 * "Pricing | Sign in | Create account" trio. When they ARE logged in, it
 * swaps to "Pricing | Dashboard | Sign out", because exposing "Sign in" or
 * "Create account" to a logged-in user is misleading — clicking either of
 * those would just bounce them to their dashboard anyway, which is what we
 * do directly here.
 *
 * Both "Sign in" and "Create account" route to /login — the unified front
 * door (Option B). The picker page handles both intents inside two
 * audience cards, so users only ever encounter one selector.
 *
 * The Dashboard link routes to the right home page based on role:
 *   platform_admin = true → /admin/onboard-school
 *   role = super_teacher  → /school
 *   role = teacher        → /teacher
 *   role = student        → /student
 */

type AuthState =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "user"; email: string; dashboard: string };

export default function PublicNav() {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setState({ kind: "anon" }); return; }
      const { data: prof } = await sb
        .from("profiles")
        .select("role, platform_admin")
        .eq("id", user.id)
        .single();
      const dashboard =
        prof?.platform_admin ? "/admin/onboard-school" :
        prof?.role === "super_teacher" ? "/school" :
        prof?.role === "teacher" ? "/teacher" :
        "/student";
      setState({ kind: "user", email: user.email || "", dashboard });
    })();
  }, []);

  async function signOut() {
    const sb = supabaseBrowser();
    await sb.auth.signOut();
    setState({ kind: "anon" });
    router.push("/");
  }

  return (
    <nav className="flex items-center gap-2 sm:gap-4">
      <Link href="/pricing" className="text-sm font-semibold text-slate-700 hover:text-emerald-700 px-2 py-1">
        Pricing
      </Link>

      {state.kind === "loading" ? (
        <div className="w-32 h-9" aria-hidden />
      ) : state.kind === "anon" ? (
        <>
          <Link href="/login" className="text-sm font-semibold text-slate-700 hover:text-emerald-700 px-2 py-1">
            Sign in
          </Link>
          <Link href="/login" className="btn btn-primary text-sm">
            Create account
          </Link>
        </>
      ) : (
        <>
          <Link
            href={state.dashboard}
            className="btn btn-primary text-sm inline-flex items-center gap-1.5"
            title={state.email || undefined}
          >
            <LayoutDashboard size={14} /> Dashboard
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="text-sm font-semibold text-slate-600 hover:text-emerald-700 px-2 py-1 inline-flex items-center gap-1"
          >
            <LogOut size={14} /> Sign out
          </button>
        </>
      )}
    </nav>
  );
}
