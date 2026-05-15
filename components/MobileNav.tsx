"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X, LogOut } from "lucide-react";
import {
  Home, Sparkles, ClipboardCheck, ListChecks,
  BarChart3, FileText, User as UserIcon, Users,
  TrendingUp, NotebookPen, Building2, FileEdit,
  Wrench, Search, Radio, MessageCircle, UserPlus,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useFeatureAccess } from "@/lib/featureAccess";

type Role = "teacher" | "student" | "super_teacher" | "platform_admin";

type Item = { href: string; label: string; icon: React.ComponentType<{ size?: number }> };
type ItemGroup = { label?: string; items: Item[] };

// Same nav definitions as Sidebar.tsx, kept minimal here so the mobile
// drawer doesn't have to import featureAccess machinery. If a route
// changes, update both files.

const TEACHER: ItemGroup[] = [
  { items: [
    { href: "/teacher",          label: "Home",            icon: Home },
    { href: "/teacher/classes",  label: "Classes",         icon: Users },
    { href: "/teacher/generate", label: "Generate Questions", icon: Sparkles },
    { href: "/teacher/review",   label: "Review Pending",     icon: ClipboardCheck },
    { href: "/teacher/quizzes",  label: "Build & Assign Tests", icon: ListChecks },
    { href: "/teacher/live",     label: "Live class quiz", icon: Radio },
    { href: "/teacher/papers",   label: "Exam Papers",     icon: FileEdit },
    { href: "/teacher/analytics", label: "Analytics",      icon: BarChart3 },
    { href: "/teacher/reports",   label: "Reports",        icon: FileText },
    { href: "/teacher/coach",  label: "Teacher Coach",     icon: MessageCircle },
    { href: "/teacher/digest", label: "This Week",         icon: Sparkles },
  ] },
];
const STUDENT: ItemGroup[] = [
  { items: [
    { href: "/student",          label: "Home",            icon: Home },
    { href: "/student/generate", label: "Take a test",     icon: Sparkles },
    { href: "/student/train",    label: "Train",           icon: Wrench },
    { href: "/student/diagnose", label: "Diagnose",        icon: Search },
    { href: "/student/tests",    label: "My Tests",        icon: NotebookPen },
    { href: "/student/progress", label: "My Progress",     icon: TrendingUp },
    { href: "/student/live",     label: "Live class quiz", icon: Radio },
  ] },
];
const SUPER_TEACHER: ItemGroup[] = [
  { items: [
    { href: "/school",          label: "School Home",  icon: Home },
    { href: "/school/teachers", label: "Teachers",     icon: UserIcon },
    { href: "/school/classes",  label: "All Classes",  icon: Building2 },
    { href: "/school/students", label: "Top Students", icon: TrendingUp },
    { href: "/school/reports",  label: "Reports",      icon: FileText },
    { href: "/school/coach",    label: "School Coach", icon: MessageCircle },
    { href: "/school/digest",   label: "This Week",    icon: Sparkles },
  ] },
];
const PLATFORM_ADMIN: ItemGroup[] = [
  { items: [
    { href: "/admin/dashboard",      label: "Dashboard",      icon: BarChart3 },
    { href: "/admin/onboard-school", label: "Onboard School", icon: Building2 },
    { href: "/admin/users",          label: "Users",          icon: Users },
    { href: "/admin/plans",          label: "Plans",          icon: ListChecks },
    { href: "/admin/team",           label: "Admin Team",     icon: UserPlus },
  ] },
];

const ROLE_HOME: Record<Role, string> = {
  teacher: "/teacher",
  student: "/student",
  super_teacher: "/school",
  platform_admin: "/admin",
};

export default function MobileNav({ role }: { role: Role }) {
  const pathname = usePathname() || "";
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Plan-gate the same entries the desktop sidebar gates. Without this
  // a Pilot-tier teacher on mobile sees /teacher/digest in the drawer,
  // taps it, and hits the new 402 quota wall — desktop hides the entry
  // instead. Keep mobile + desktop in sync.
  const access = useFeatureAccess();
  const baseGroups =
    role === "teacher" ? TEACHER :
    role === "super_teacher" ? SUPER_TEACHER :
    role === "platform_admin" ? PLATFORM_ADMIN :
    STUDENT;
  const groups = baseGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((it) => {
        if (it.href === "/teacher/digest" || it.href === "/school/digest") {
          if (access.isLoading) return true; // optimistic
          return access.allowed.has("weekly_digest");
        }
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0);

  async function logout() {
    // Same aggressive sign-out as the desktop sidebar — wipe auth tokens
    // + per-user cache keys from local/session storage and hard-navigate
    // away so no React state or supabase singleton survives with a stale
    // identity.
    try { await supabaseBrowser().auth.signOut({ scope: "local" }); } catch { /* ignore */ }
    if (typeof window !== "undefined") {
      try {
        const ls = window.localStorage;
        for (let i = ls.length - 1; i >= 0; i--) {
          const k = ls.key(i);
          if (!k) continue;
          if (k.startsWith("sb-") || k.startsWith("bloomiq_") || k.startsWith("bloomiq:") || k.startsWith("supabase.")) ls.removeItem(k);
        }
        const ss = window.sessionStorage;
        for (let i = ss.length - 1; i >= 0; i--) {
          const k = ss.key(i);
          if (!k) continue;
          if (k.startsWith("sb-") || k.startsWith("bloomiq_") || k.startsWith("bloomiq:") || k.startsWith("supabase.")) ss.removeItem(k);
        }
      } catch { /* non-fatal */ }
      window.location.replace("/");
      return;
    }
    router.push("/");
  }

  return (
    <>
      <header
        className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 backdrop-blur"
        style={{
          background: "color-mix(in oklab, var(--color-card) 85%, transparent)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <Link href={ROLE_HOME[role]} className="flex items-center gap-2">
          <span className="text-2xl">🌱</span>
          <span className="font-bold tracking-tight">BloomIQ</span>
        </Link>
        <button type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="bloomiq-mobile-nav-panel"
          className="p-2 rounded-lg"
          style={{ color: "var(--color-fg-soft)" }}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {open && (
        <div
          id="bloomiq-mobile-nav-panel"
          role="dialog"
          aria-label="Navigation menu"
          aria-modal="true"
          className="md:hidden fixed inset-0 top-[57px] z-20 overflow-y-auto"
          style={{ background: "var(--color-bg)" }}
          onClick={() => setOpen(false)}
        >
          <nav className="p-4 flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
            {groups.map((g, gi) => (
              <div key={gi}>
                {g.label && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider muted">{g.label}</div>
                )}
                {g.items.map(({ href, label, icon: Icon }) => {
                  const active = pathname === href || (href !== ROLE_HOME[role] && pathname.startsWith(href));
                  return (
                    <Link
                      key={href}
                      href={href}
                      className="flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition"
                      style={
                        active
                          ? { background: "var(--color-accent-soft)", color: "var(--brand-700)", fontWeight: 600 }
                          : { color: "var(--color-fg-soft)" }
                      }
                    >
                      <Icon size={18} />
                      {label}
                    </Link>
                  );
                })}
              </div>
            ))}
            <button type="button"
              onClick={logout}
              className="flex items-center gap-3 px-3 py-3 rounded-lg text-sm mt-3 border-t pt-4"
              style={{ color: "var(--color-fg-soft)", borderColor: "var(--color-border)" }}
            >
              <LogOut size={16} /> Sign out
            </button>
          </nav>
        </div>
      )}
    </>
  );
}
