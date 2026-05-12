"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Home, Sparkles, ClipboardCheck, ListChecks,
  BarChart3, FileText, LogOut, User as UserIcon, Users,
  TrendingUp, NotebookPen, Building2, FileEdit,
  ShieldCheck, ArrowUpRight, Wrench, Search, Radio,
  MessageCircle, HelpCircle, UserPlus, CreditCard,
} from "lucide-react";

type SidebarRole = "teacher" | "student" | "super_teacher" | "platform_admin";
import ThemeQuickToggle from "@/components/ThemeQuickToggle";
import { useFeatureAccess, tierLabel } from "@/lib/featureAccess";

type Item = { href: string; label: string; icon: React.ComponentType<{ size?: number }> };
type ItemGroup = { label?: string; items: Item[] };

const TEACHER: ItemGroup[] = [
  { label: "Classes", items: [
    { href: "/teacher",         label: "Home",    icon: Home },
    { href: "/teacher/classes", label: "Classes", icon: Users },
  ] },
  { label: "Content", items: [
    { href: "/teacher/generate", label: "Generate Questions", icon: Sparkles },
    { href: "/teacher/review",   label: "Review Pending",     icon: ClipboardCheck },
    { href: "/teacher/quizzes",  label: "Build & Assign Tests", icon: ListChecks },
    { href: "/teacher/live",     label: "Live class quiz", icon: Radio },
    { href: "/teacher/papers",   label: "Exam Papers",     icon: FileEdit },
  ] },
  // Order: Reports first because it's the cross-class / cross-test
  // grand summary teachers want most often (term reviews, parent
  // meetings). Analytics is intentionally test-scoped — pick a test,
  // see only that test — so it sits below and is labelled accordingly.
  { label: "Insights", items: [
    { href: "/teacher/reports",   label: "Reports",        icon: FileText },
    { href: "/teacher/analytics", label: "Test analytics", icon: BarChart3 },
  ] },
  { label: "Assist", items: [
    { href: "/teacher/coach",  label: "Teacher Coach", icon: MessageCircle },
    { href: "/teacher/digest", label: "This Week",     icon: Sparkles },
  ] },
];

// School students have TWO distinct mental models that need to stay
// visually separate to keep navigation simple:
//
//   1) "Class" — anything teacher-driven that influences class stats:
//      Live class quizzes hosted by the teacher, class Bloom mastery,
//      class averages. The Home page's "Assigned to you" cards live
//      under the same umbrella but render on the dashboard itself.
//
//   2) "Practice" — anything self-driven that does NOT touch class
//      stats: the student's own practice tests, skill training, weak-
//      spot diagnosis, and the history of those practice attempts.
//
// Mixing these two into a single verb-based group ("Do / Look back",
// like the independent sidebar uses) was confusing for school
// students — a Live class quiz and a self-initiated practice test
// look identical in that grouping but are completely different
// things from the kid's perspective. So we group by audience axis
// here, mirroring the order the home dashboard itself uses
// (Assigned → Class stats → Practice tiles).
//
// The independent sidebar keeps its verb grouping because independent
// students have no class concept — there's only practice, so verbs
// are the most useful axis for them.
//
// Train / Diagnose links stay in the sidebar regardless of the
// school's plan tier; the landing pages render only the tiles the
// plan unlocks (via lib/featureAccess). That keeps sidebar layout
// stable when a school upgrades or downgrades.
const STUDENT_SCHOOL: ItemGroup[] = [
  { items: [{ href: "/student", label: "Home", icon: Home }] },
  { label: "Class", items: [
    { href: "/student/live",     label: "Live class quiz",   icon: Radio },
    { href: "/student/progress", label: "My Class Progress", icon: TrendingUp },
  ] },
  { label: "Practice", items: [
    { href: "/student/generate", label: "Take a practice test", icon: Sparkles },
    { href: "/student/train",    label: "Train your skills",    icon: Wrench },
    { href: "/student/diagnose", label: "Diagnose a weakness",  icon: Search },
    { href: "/student/tests",    label: "My Practice",          icon: NotebookPen },
  ] },
];

const STUDENT_INDEPENDENT: ItemGroup[] = [
  { items: [{ href: "/student", label: "Home", icon: Home }] },
  { label: "Do", items: [
    { href: "/student/generate", label: "Take a test",         icon: Sparkles },
    { href: "/student/train",    label: "Train your skills",   icon: Wrench },
    { href: "/student/diagnose", label: "Diagnose a weakness", icon: Search },
  ] },
  { label: "Look back", items: [
    { href: "/student/tests",    label: "My Tests",    icon: NotebookPen },
    { href: "/student/progress", label: "My Progress", icon: TrendingUp },
  ] },
];

const SUPER_TEACHER: ItemGroup[] = [
  // ROSTER — who's in this school. The dashboard ("School Home")
  // lives here because it's primarily an at-a-glance view of
  // teachers / classes / students rolled up.
  { label: "Roster", items: [
    { href: "/school",          label: "School Home",  icon: Home },
    { href: "/school/teachers", label: "Teachers",     icon: UserIcon },
    { href: "/school/classes",  label: "All Classes",  icon: Building2 },
    { href: "/school/students", label: "Top Students", icon: TrendingUp },
  ] },
  // INSIGHTS — formal reporting. Bloom-by-class breakdowns,
  // engagement, at-risk lists. Standalone group because Reports is
  // a substantial destination on its own.
  { label: "Insights", items: [
    { href: "/school/reports", label: "Reports", icon: FileText },
  ] },
  // ASSIST — AI helpers. Promoted from home tiles to sidebar so
  // the school admin can reach them in one click from anywhere
  // (matches the teacher sidebar's Assist group).
  { label: "Assist", items: [
    { href: "/school/coach",  label: "School Coach", icon: MessageCircle },
    { href: "/school/digest", label: "This Week",    icon: Sparkles },
  ] },
  // ACCOUNT — D7. Read-only billing visibility so the super_teacher can
  // see their plan + invoice + payment status without pinging the platform
  // admin team.
  { label: "Account", items: [
    { href: "/school/billing", label: "Billing", icon: CreditCard },
  ] },
];

// ===== Platform admin (BloomIQ internal staff) =====
// Flat list — only a handful of destinations and they don't cluster
// into obvious sub-categories. Bottom nav still adds Profile / Help /
// Security / Sign out via the shared component code below.
const PLATFORM_ADMIN: ItemGroup[] = [
  { items: [
    { href: "/admin/dashboard",      label: "Dashboard",      icon: BarChart3 },
    { href: "/admin/onboard-school", label: "Onboard School", icon: Building2 },
    { href: "/admin/users",          label: "Users",          icon: Users },
    { href: "/admin/plans",          label: "Plans",          icon: ListChecks },
    { href: "/admin/team",           label: "Admin Team",     icon: UserPlus },
  ] },
];

// Map a sidebar role to its home URL — used for the BloomIQ branding
// link in the header. We can't just say `/${role}` anymore because
// platform_admin doesn't have a /platform_admin route (it's /admin),
// and super_teacher's home is /school not /super_teacher.
const ROLE_HOME: Record<SidebarRole, string> = {
  teacher: "/teacher",
  student: "/student",
  super_teacher: "/school",
  platform_admin: "/admin",
};

// Map a sidebar role to its display label for the small "X dashboard"
// caption under the BloomIQ wordmark. Title-case underscores would
// otherwise produce ugly strings like "Platform_admin dashboard".
const ROLE_LABEL: Record<SidebarRole, string> = {
  teacher: "Teacher",
  student: "Student",
  super_teacher: "School admin",
  platform_admin: "Platform admin",
};

export default function Sidebar({ role }: { role: SidebarRole }) {
  const pathname = usePathname();
  const router = useRouter();
  const [name, setName] = useState<string>("");
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  const access = useFeatureAccess();

  useEffect(() => {
    (async () => {
      // Use the service-role /api/auth/me lookup instead of reading profiles
      // directly. The user-token client races RLS on the edge, which made
      // the sidebar briefly show the wrong user's name on first paint after
      // login (and forced users to hard-refresh to see themselves).
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      const r = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = await r.json() as { full_name: string | null; email: string | null; is_school_student: boolean };
      setName(j.full_name || j.email || "");
      setIsSchoolStudent(!!j.is_school_student);
    })();
  }, []);

  const baseItems =
    role === "teacher" ? TEACHER :
    role === "super_teacher" ? SUPER_TEACHER :
    role === "platform_admin" ? PLATFORM_ADMIN :
    isSchoolStudent === null ? [] :
    isSchoolStudent ? STUDENT_SCHOOL : STUDENT_INDEPENDENT;

  // Filter out entries the user's plan doesn't include. Currently
  // only "This Week" (digest) is plan-gated — Pilot loses it,
  // Standard + Plus keep it. Other entries stay visible across
  // all tiers (analytics is intentionally not tiered). If we add
  // more plan-gated sidebar entries later, extend the map here.
  const items = baseItems.map((group) => ({
    ...group,
    items: group.items.filter((it) => {
      if (it.href === "/teacher/digest" || it.href === "/school/digest") {
        // Plan still loading? Show optimistically — better to flicker the
        // entry once than to hide a valid entry from a paying admin.
        if (access.isLoading) return true;
        return access.allowed.has("weekly_digest");
      }
      return true;
    }),
  })).filter((g) => g.items.length > 0);

  async function logout() {
    // Sign out, then aggressively wipe any auth-shaped local storage so a
    // stale token from a previous session can't be read by code that
    // mounts before supabase-js finishes clearing its own copy. We have
    // seen RSC / page mounts query the wrong user_id (a deleted account)
    // until the user hard-refreshed; this prevents that recurring.
    try { await supabaseBrowser().auth.signOut({ scope: "local" }); } catch { /* ignore */ }
    if (typeof window !== "undefined") {
      try {
        const ls = window.localStorage;
        for (let i = ls.length - 1; i >= 0; i--) {
          const k = ls.key(i);
          if (!k) continue;
          if (k.startsWith("sb-") || k.startsWith("bloomiq_") || k.startsWith("supabase.")) {
            ls.removeItem(k);
          }
        }
        const ss = window.sessionStorage;
        for (let i = ss.length - 1; i >= 0; i--) {
          const k = ss.key(i);
          if (!k) continue;
          if (k.startsWith("sb-") || k.startsWith("bloomiq_") || k.startsWith("supabase.")) {
            ss.removeItem(k);
          }
        }
      } catch { /* private mode / quota — non-fatal */ }
      // Hard-replace the location so React state, in-flight RSC fetches,
      // and the supabase client are all torn down. router.push leaves the
      // singletons alive and was the root of the cross-account leakage.
      window.location.replace("/");
      return;
    }
    router.push("/");
  }

  return (
    <aside className="w-60 min-h-screen hidden md:flex flex-col shrink-0" style={{ background: "var(--color-card)", borderRight: "1px solid var(--color-border)" }}>
      <div className="p-5" style={{ borderBottom: "1px solid var(--color-border)" }}>
        <Link href={ROLE_HOME[role]} className="flex items-center gap-2">
          <span className="text-2xl">&#x1F331;</span>
          <span className="text-lg font-bold tracking-tight">BloomIQ</span>
        </Link>
        <div className="mt-1 text-xs muted">{ROLE_LABEL[role]} dashboard</div>
      </div>
      <nav className="p-3 flex-1 flex flex-col gap-1">
        {items.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-3" : ""}>
            {group.label && (
              <div className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-fg-muted, var(--color-fg-soft))", opacity: 0.7 }}>
                {group.label}
              </div>
            )}
            <div className="flex flex-col gap-1">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || (href !== ROLE_HOME[role] && pathname.startsWith(href));
                return (
                  <Link key={href} href={href} className={"sidebar-link flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition" + (active ? " sidebar-link--active" : "")}>
                    <Icon size={18} />
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="p-3" style={{ borderTop: "1px solid var(--color-border)" }}>
        <ThemeQuickToggle />
        <div className="flex items-center gap-2 px-3 py-2 text-xs muted">
          <UserIcon size={14} />
          <span className="truncate">{name || "..."}</span>
        </div>
        {role === "student" && !access.isLoading && (
          <TierChip tier={access.planTier} tierLabel={access.planTier === "anon" ? "&mdash;" : tierLabel(access.planTier)} isExpired={access.isExpired} source={access.source} />
        )}
        <Link href="/settings/profile" className="sidebar-link w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition">
          <UserIcon size={16} /> Profile
        </Link>
        <Link href="/help" className="sidebar-link w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition">
          <HelpCircle size={16} /> Help
        </Link>
        {isSchoolStudent === false && (
          <Link href="/settings/security" className="sidebar-link w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition">
            <ShieldCheck size={16} /> Security
          </Link>
        )}
        <button type="button" onClick={logout} className="sidebar-link w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition">
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );
}

function TierChip({ tier, tierLabel, isExpired, source }: { tier: string; tierLabel: string; isExpired: boolean; source: "personal" | "school" | "none" }) {
  const isFreeOrAnon = tier === "free" || tier === "anon";
  const isSchoolPlan = source === "school";
  if (isExpired && !isSchoolPlan) {
    return (
      <Link href="/pricing" className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: "color-mix(in oklab, #fee 60%, transparent)", color: "#a40000", border: "1px solid #fcc" }}>
        <span>{tierLabel} &middot; expired</span>
        <span className="inline-flex items-center gap-0.5">Renew <ArrowUpRight size={12} /></span>
      </Link>
    );
  }
  if (isFreeOrAnon && !isSchoolPlan) {
    return (
      <Link href="/pricing" className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: "color-mix(in oklab, var(--brand-100, #d1fae5) 50%, transparent)", color: "var(--brand-700, #047857)", border: "1px solid var(--brand-300, #6ee7b7)" }}>
        <span>{tierLabel}</span>
        <span className="inline-flex items-center gap-0.5">Upgrade <ArrowUpRight size={12} /></span>
      </Link>
    );
  }
  if (isSchoolPlan) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: "var(--color-bg-soft)", color: "var(--color-fg-soft)", border: "1px solid var(--color-border)" }}>
        <span>{tierLabel}</span>
        <span className="text-[10px] uppercase tracking-wide">school plan</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: "color-mix(in oklab, var(--brand-100, #d1fae5) 30%, transparent)", color: "var(--brand-700, #047857)", border: "1px solid var(--color-border)" }}>
      <span>{tierLabel}</span>
      <span className="text-[10px] uppercase tracking-wide">active</span>
    </div>
  );
}
