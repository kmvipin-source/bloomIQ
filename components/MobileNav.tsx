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
    { href: "/teacher/generate", label: "Generate",        icon: Sparkles },
    { href: "/teacher/review",   label: "Review",          icon: ClipboardCheck },
    { href: "/teacher/quizzes",  label: "Tests",           icon: ListChecks },
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

  const groups =
    role === "teacher" ? TEACHER :
    role === "super_teacher" ? SUPER_TEACHER :
    role === "platform_admin" ? PLATFORM_ADMIN :
    STUDENT;

  async function logout() {
    await supabaseBrowser().auth.signOut();
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
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          className="p-2 rounded-lg"
          style={{ color: "var(--color-fg-soft)" }}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {open && (
        <div
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
            <button
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
