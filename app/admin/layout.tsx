"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ShieldCheck, Building2, ListChecks, UserPlus, LogOut, ArrowLeft } from "lucide-react";
import ThemeQuickToggle from "@/components/ThemeQuickToggle";

/**
 * /admin/* — internal BloomIQ staff pages.
 *
 * Gated by profiles.platform_admin = true. Anyone without the flag is
 * bounced to /. The bootstrap admin must be flipped via SQL once;
 * everyone else is granted from /admin/team.
 *
 * Visual shell:
 *   - Slim top bar with logo, "Platform Admin" badge, section nav,
 *     theme quick-toggle, and sign-out.
 *   - Theme-aware (uses CSS vars) so the appearance picker actually
 *     reskins admin pages too.
 *   - On mobile, section nav wraps to a second row.
 */

const ADMIN_LINKS = [
  { href: "/admin/onboard-school", label: "Onboard School", icon: Building2 },
  { href: "/admin/plans",          label: "Plans",          icon: ListChecks },
  { href: "/admin/team",           label: "Admin Team",     icon: UserPlus },
  { href: "/settings/security",    label: "Security",       icon: ShieldCheck },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
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

  async function logout() {
    await supabaseBrowser().auth.signOut();
    router.push("/");
  }

  if (!ok) {
    return (
      <div className="min-h-screen grid place-items-center" style={{ background: "var(--color-bg)" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--color-bg)" }}>
      <header
        className="sticky top-0 z-20 backdrop-blur"
        style={{
          background: "color-mix(in oklab, var(--color-card) 80%, transparent)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">BloomIQ</span>
            <span
              className="hidden sm:inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-bold"
              style={{
                background: "var(--brand-700)",
                color: "#fff",
              }}
            >
              <ShieldCheck size={10} /> Platform Admin
            </span>
          </Link>

          {/* Section nav — desktop. Active section uses the theme accent. */}
          <nav className="hidden md:flex items-center gap-1 ml-2">
            {ADMIN_LINKS.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + "/");
              return (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition"
                  style={
                    active
                      ? {
                          background: "var(--color-accent-soft)",
                          color: "var(--brand-700)",
                          fontWeight: 600,
                        }
                      : { color: "var(--color-fg-soft)" }
                  }
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "var(--color-bg-soft)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <Icon size={14} /> {label}
                </Link>
              );
            })}
          </nav>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition"
              style={{ color: "var(--color-fg-soft)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-bg-soft)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              title="Back to home"
            >
              <ArrowLeft size={13} /> Home
            </Link>
            {/* Theme picker — 5 swatches + sun/moon. Only as wide as it
                needs to be; the inner ThemeQuickToggle is meant for a
                sidebar so we constrain its outer width here. */}
            <div style={{ width: 220 }}>
              <ThemeQuickToggle />
            </div>
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition"
              style={{ color: "var(--color-fg-soft)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-bg-soft)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              title="Sign out"
            >
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>

        {/* Mobile section nav */}
        <nav
          className="md:hidden flex items-center gap-1 px-4 pb-3 overflow-x-auto"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          {ADMIN_LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition mt-3"
                style={
                  active
                    ? {
                        background: "var(--color-accent-soft)",
                        color: "var(--brand-700)",
                        fontWeight: 600,
                      }
                    : { color: "var(--color-fg-soft)" }
                }
              >
                <Icon size={14} /> {label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">{children}</main>
    </div>
  );
}
