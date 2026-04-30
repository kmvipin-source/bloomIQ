"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Home, Sparkles, ClipboardCheck, ListChecks,
  BarChart3, FileText, LogOut, User as UserIcon, Users,
  TrendingUp, NotebookPen, Building2, FileEdit,
  ShieldCheck, UserPlus,
} from "lucide-react";

type Item = { href: string; label: string; icon: React.ComponentType<{ size?: number }> };

const TEACHER: Item[] = [
  { href: "/teacher",            label: "Home",          icon: Home },
  { href: "/teacher/generate",   label: "Generate",      icon: Sparkles },
  { href: "/teacher/review",     label: "Review",        icon: ClipboardCheck },
  { href: "/teacher/quizzes",    label: "Quizzes",       icon: ListChecks },
  { href: "/teacher/papers",     label: "Exam Papers",   icon: FileEdit },
  { href: "/teacher/classes",    label: "Classes",       icon: Users },
  { href: "/teacher/analytics",  label: "Analytics",     icon: BarChart3 },
  { href: "/teacher/reports",    label: "Reports",       icon: FileText },
];

// School student — they're enrolled in a class, take assigned quizzes.
const STUDENT_SCHOOL: Item[] = [
  { href: "/student",         label: "Home",       icon: Home },
  { href: "/student/join",    label: "Join Quiz",  icon: ClipboardCheck },
  { href: "/student/classes", label: "My Classes", icon: Users },
];

// Independent student — self-study with their own subscription. No classes.
// Sidebar is intentionally minimal — only the actions a student takes daily.
// All eight "Boost your learning" + "Ace competitive exams" features (Teach-
// Back, Misconceptions, Daily Climb, Past-Paper X-Ray, Speed-Accuracy, Trap
// Detector, Mock Rank Predictor, AI Tutor) live as tile groups on the
// /student dashboard so the sidebar stays a quick-jump for the core flow
// instead of a flat 12-item list.
const STUDENT_INDEPENDENT: Item[] = [
  { href: "/student",          label: "Home",        icon: Home },
  { href: "/student/generate", label: "New Test",    icon: Sparkles },
  { href: "/student/tests",    label: "My Tests",    icon: NotebookPen },
  { href: "/student/progress", label: "My Progress", icon: TrendingUp },
];

// Super teacher — school-level admin. Sees across all teachers + classes.
const SUPER_TEACHER: Item[] = [
  { href: "/school",          label: "School Home",  icon: Home },
  { href: "/school/teachers", label: "Teachers",     icon: UserIcon },
  { href: "/school/classes",  label: "All Classes",  icon: Building2 },
  { href: "/school/students", label: "Top Students", icon: TrendingUp },
];

// Platform admin — BloomIQ staff. Surfaced as an extra section in the
// sidebar when profiles.platform_admin = true, regardless of role. Lets
// the staff user jump straight to /admin/* without typing the URL.
const PLATFORM_ADMIN: Item[] = [
  { href: "/admin/onboard-school", label: "Onboard School", icon: Building2 },
  { href: "/admin/team",           label: "Admin Team",     icon: UserPlus },
];

export default function Sidebar({ role }: { role: "teacher" | "student" | "super_teacher" }) {
  const pathname = usePathname();
  const router = useRouter();
  const [name, setName] = useState<string>("");
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  // Surfaces the Platform Admin section below the role nav when true.
  // Defaults to false so the link is hidden until we've actually verified.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data } = await sb
        .from("profiles")
        .select("full_name, is_school_student, platform_admin")
        .eq("id", user.id)
        .single();
      setName(data?.full_name || user.email || "");
      setIsSchoolStudent(!!data?.is_school_student);
      setIsPlatformAdmin(!!data?.platform_admin);
    })();
  }, []);

  const items =
    role === "teacher" ? TEACHER :
    role === "super_teacher" ? SUPER_TEACHER :
    isSchoolStudent === null ? [] :
    isSchoolStudent ? STUDENT_SCHOOL : STUDENT_INDEPENDENT;

  async function logout() {
    await supabaseBrowser().auth.signOut();
    router.push("/");
  }

  return (
    <aside className="w-60 bg-white border-r border-slate-200 min-h-screen flex flex-col">
      <div className="p-5 border-b border-slate-100">
        <Link href={`/${role}`} className="flex items-center gap-2">
          <span className="text-2xl">🌱</span>
          <span className="text-lg font-bold tracking-tight">BloomIQ</span>
        </Link>
        <div className="mt-1 text-xs muted capitalize">{role} dashboard</div>
      </div>
      <nav className="p-3 flex-1 flex flex-col gap-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== `/${role}` && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                active
                  ? "bg-emerald-50 text-emerald-800 font-semibold"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          );
        })}

        {/* Platform Admin section — only rendered for BloomIQ staff. The flag
            is fetched once on mount; while it's loading we render nothing so
            the link doesn't briefly flash for non-admin users. */}
        {isPlatformAdmin && (
          <>
            <div className="mt-4 mb-1 px-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-bold text-slate-400">
              <ShieldCheck size={11} /> Platform Admin
            </div>
            {PLATFORM_ADMIN.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + "/");
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                    active
                      ? "bg-slate-900 text-white font-semibold"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              );
            })}
          </>
        )}
      </nav>
      <div className="p-3 border-t border-slate-100">
        <div className="flex items-center gap-2 px-3 py-2 text-xs muted">
          <UserIcon size={14} />
          <span className="truncate">{name || "..."}</span>
        </div>
        <button onClick={logout} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-50">
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );
}
