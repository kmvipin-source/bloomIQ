"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import Link from "next/link";
import { BarChart3, Users, Building2, GraduationCap, IndianRupee, Sparkles, Crown, School, Receipt, TrendingUp, Calendar, AlertCircle, ArrowRight } from "lucide-react";

type PlanRow = {
  slug: string;
  label: string;
  tier: string;
  category: string;
  pricing_model: string;
  list_price_paise: number;
  members: number;
  revenue_paise: number;
};
type Category = {
  name: string;
  members: number;
  revenue_paise: number;
  rows: PlanRow[];
};
type Totals = {
  total_users: number;
  students: number;
  school_students: number;
  teachers: number;
  schools_onboarded: number;
  paying_subscribers: number;
  total_revenue_paise: number;
};
type TeacherRow = { name: string; school: string; sub_role: "super_teacher" | "primary" | "co_teacher" | "unassigned" };
type TeacherCounts = { super_teacher: number; primary: number; co_teacher: number; unassigned: number };
type ExpiringRow = {
  school_id: string;
  school_name: string;
  plan_label: string | null;
  expires_at: string;
  days_until: number;
};
type Payload = {
  totals: Totals;
  categories: Category[];
  topSchools: { name: string; students: number }[];
  teachers: TeacherRow[];
  teacherCounts: TeacherCounts;
  expiringSoon: ExpiringRow[];
};

const fmtRupee = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const CAT_ORDER = ["Free", "Premium", "Premium Plus", "School", "Other"];
const CAT_META: Record<string, { Icon: React.ComponentType<{ size?: number; className?: string }>; tone: string }> = {
  Free: { Icon: Users, tone: "slate" },
  Premium: { Icon: Sparkles, tone: "emerald" },
  "Premium Plus": { Icon: Crown, tone: "violet" },
  School: { Icon: School, tone: "sky" },
  Other: { Icon: Receipt, tone: "slate" },
};
const TONE: Record<string, { bg: string; fg: string; ring: string }> = {
  slate: { bg: "#f1f5f9", fg: "#0f172a", ring: "#cbd5e1" },
  emerald: { bg: "#d1fae5", fg: "#065f46", ring: "#10b981" },
  violet: { bg: "#ede9fe", fg: "#5b21b6", ring: "#8b5cf6" },
  sky: { bg: "#e0f2fe", fg: "#075985", ring: "#0ea5e9" },
};

export default function AdminDashboardPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error("Not signed in.");
        const r = await fetch("/api/admin/dashboard", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed");
        setData(j);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed");
      }
    })();
  }, []);

  if (err) {
    return (
      <div className="card border-red-200 bg-red-50">
        <div className="font-bold text-red-700">Could not load dashboard</div>
        <div className="text-sm text-red-700 mt-1">{err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid place-items-center h-64">
        <div className="spinner" />
      </div>
    );
  }

  const { totals, categories, topSchools, teachers, teacherCounts, expiringSoon } = data;
  const teachersBySchool = new Map<string, TeacherRow[]>();
  for (const t of teachers) {
    const arr = teachersBySchool.get(t.school) || [];
    arr.push(t);
    teachersBySchool.set(t.school, arr);
  }
  const orderedCats = [...categories].sort((a, b) => CAT_ORDER.indexOf(a.name) - CAT_ORDER.indexOf(b.name));

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart3 size={26} /> Platform dashboard</h1>
        <p className="text-sm muted mt-1">Adoption, plan mix, and revenue across BloomIQ. Counts only — no PII.</p>
      </div>

      {/* Big-number tiles */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile icon={<Users size={18} />} label="Total users" value={totals.total_users.toLocaleString("en-IN")} />
        <Tile icon={<GraduationCap size={18} />} label="Independent students" value={totals.students.toLocaleString("en-IN")} />
        <Tile icon={<School size={18} />} label="School students" value={totals.school_students.toLocaleString("en-IN")} />
        <Tile icon={<Building2 size={18} />} label="Schools onboarded" value={totals.schools_onboarded.toLocaleString("en-IN")} />
        <Tile icon={<TrendingUp size={18} />} label="Paying subscribers" value={totals.paying_subscribers.toLocaleString("en-IN")} accent="emerald" />
        <Tile icon={<Users size={18} />} label="Teachers" value={totals.teachers.toLocaleString("en-IN")} />
        <Tile icon={<IndianRupee size={18} />} label="Revenue (active term)" value={fmtRupee(totals.total_revenue_paise)} accent="emerald" />
      </section>

      {/* Categories */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3">By plan category</h2>
        <div className="space-y-4">
          {orderedCats.map((c) => {
            const { Icon, tone } = CAT_META[c.name] || CAT_META.Other;
            const t = TONE[tone];
            return (
              <div key={c.name} className="card p-0 overflow-hidden" style={{ borderColor: t.ring }}>
                <div
                  className="px-5 py-3 flex items-center gap-3 flex-wrap"
                  style={{ background: t.bg, color: t.fg }}
                >
                  <div
                    className="w-9 h-9 rounded-full grid place-items-center"
                    style={{ background: "#fff", color: t.fg, border: `1px solid ${t.ring}` }}
                  >
                    <Icon size={16} />
                  </div>
                  <div className="font-bold">{c.name}</div>
                  <div className="ml-auto flex items-center gap-4 text-xs font-semibold">
                    <span>{c.members.toLocaleString("en-IN")} members</span>
                    <span className="px-2 py-0.5 rounded-full bg-white/70">{fmtRupee(c.revenue_paise)}</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left" style={{ background: "var(--color-bg-soft)" }}>
                        <th className="px-4 py-2 font-semibold">Plan</th>
                        <th className="px-4 py-2 font-semibold">Pricing</th>
                        <th className="px-4 py-2 font-semibold text-right">List price</th>
                        <th className="px-4 py-2 font-semibold text-right">Members</th>
                        <th className="px-4 py-2 font-semibold text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.rows.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-4 muted text-center">No plans yet</td></tr>
                      )}
                      {c.rows.map((r) => (
                        <tr key={r.slug} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                          <td className="px-4 py-2.5 font-medium">{r.label}</td>
                          <td className="px-4 py-2.5 text-xs muted capitalize">{r.pricing_model.replace("_", " ")}</td>
                          <td className="px-4 py-2.5 text-right">{r.list_price_paise > 0 ? fmtRupee(r.list_price_paise) : "—"}</td>
                          <td className="px-4 py-2.5 text-right font-semibold">{r.members.toLocaleString("en-IN")}</td>
                          <td className="px-4 py-2.5 text-right">{r.revenue_paise > 0 ? fmtRupee(r.revenue_paise) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>

        {/* Grand total */}
        <div
          className="mt-4 card flex items-center gap-3"
          style={{
            background: "linear-gradient(135deg, var(--color-accent-soft), var(--color-card))",
            borderColor: "var(--brand-700)",
          }}
        >
          <div className="w-10 h-10 rounded-full grid place-items-center text-white" style={{ background: "var(--brand-700)" }}>
            <IndianRupee size={18} />
          </div>
          <div className="flex-1">
            <div className="text-xs uppercase tracking-wider muted font-semibold">Grand total revenue</div>
            <div className="text-xl font-bold">{fmtRupee(totals.total_revenue_paise)}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider muted font-semibold">Active subscribers</div>
            <div className="text-xl font-bold">{totals.paying_subscribers.toLocaleString("en-IN")}</div>
          </div>
        </div>
      </section>

      {/* Upcoming expirations — schools whose plan expires in the next
          60 days OR is already expired. The platform admin uses this to
          chase renewals before students lose access. Sorted soonest first. */}
      {expiringSoon && expiringSoon.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
            <Calendar size={16} /> Upcoming plan expirations
            <span className="text-xs font-normal normal-case muted">— next 60 days</span>
          </h2>
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ background: "var(--color-bg-soft)" }}>
                  <th className="px-4 py-2 font-semibold">School</th>
                  <th className="px-4 py-2 font-semibold">Plan</th>
                  <th className="px-4 py-2 font-semibold">Expires</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {expiringSoon.map((r) => {
                  const expired = r.days_until < 0;
                  const urgent  = !expired && r.days_until <= 14;
                  return (
                    <tr key={r.school_id} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                      <td className="px-4 py-2.5 font-medium">{r.school_name}</td>
                      <td className="px-4 py-2.5 text-xs muted">{r.plan_label || "—"}</td>
                      <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                        {new Date(r.expires_at).toLocaleDateString("en-IN", {
                          year: "numeric", month: "short", day: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-2.5">
                        {expired ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                            <AlertCircle size={12} /> Expired {Math.abs(r.days_until)}d ago
                          </span>
                        ) : urgent ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                            <AlertCircle size={12} /> {r.days_until}d left
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5">
                            <Calendar size={12} /> {r.days_until}d left
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/admin/schools/${r.school_id}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
                          title="Open per-school admin: renew plan, generate invoice, mark NEFT received"
                        >
                          Manage <ArrowRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Teachers — by school + sub-role */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3">Teachers</h2>

        {/* Sub-role tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Tile icon={<Users size={18} />} label="Super teachers" value={teacherCounts.super_teacher.toLocaleString("en-IN")} accent="emerald" />
          <Tile icon={<Users size={18} />} label="Primary teachers" value={teacherCounts.primary.toLocaleString("en-IN")} />
          <Tile icon={<Users size={18} />} label="Co-teachers" value={teacherCounts.co_teacher.toLocaleString("en-IN")} />
          <Tile icon={<Users size={18} />} label="Unassigned" value={teacherCounts.unassigned.toLocaleString("en-IN")} />
        </div>

        {/* Per-school grouping */}
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ background: "var(--color-bg-soft)" }}>
                <th className="px-4 py-2 font-semibold">School</th>
                <th className="px-4 py-2 font-semibold">Teacher</th>
                <th className="px-4 py-2 font-semibold">Role</th>
              </tr>
            </thead>
            <tbody>
              {teachers.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-6 muted text-center">No teachers yet.</td></tr>
              )}
              {Array.from(teachersBySchool.entries()).map(([school, list]) =>
                list.map((t, i) => (
                  <tr key={`${school}-${t.name}-${i}`} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                    <td className="px-4 py-2.5 font-medium">{i === 0 ? school : <span className="muted">↳</span>}</td>
                    <td className="px-4 py-2.5">{t.name}</td>
                    <td className="px-4 py-2.5">{roleBadge(t.sub_role)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Top schools */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-3">Top schools by student count</h2>
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ background: "var(--color-bg-soft)" }}>
                <th className="px-4 py-2 font-semibold">School</th>
                <th className="px-4 py-2 font-semibold text-right">Students</th>
              </tr>
            </thead>
            <tbody>
              {topSchools.length === 0 && (
                <tr><td colSpan={2} className="px-4 py-6 muted text-center">No schools onboarded yet.</td></tr>
              )}
              {topSchools.map((s) => (
                <tr key={s.name} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                  <td className="px-4 py-2.5 font-medium">{s.name}</td>
                  <td className="px-4 py-2.5 text-right">{s.students.toLocaleString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function roleBadge(sub: TeacherRow["sub_role"]) {
  const cfg: Record<TeacherRow["sub_role"], { label: string; bg: string; fg: string }> = {
    super_teacher: { label: "Super Teacher", bg: "#d1fae5", fg: "#065f46" },
    primary:       { label: "Primary",        bg: "#dbeafe", fg: "#1e3a8a" },
    co_teacher:    { label: "Co-teacher",     bg: "#ede9fe", fg: "#5b21b6" },
    unassigned:    { label: "Unassigned",     bg: "#f1f5f9", fg: "#475569" },
  };
  const c = cfg[sub];
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: c.bg, color: c.fg }}>
      {c.label}
    </span>
  );
}

function Tile({
  icon,
  label,
  value,
  accent = "slate",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: "slate" | "emerald";
}) {
  const a = accent === "emerald";
  return (
    <div className="card p-4 flex items-center gap-3">
      <div
        className="w-10 h-10 rounded-lg grid place-items-center shrink-0"
        style={{
          background: a ? "var(--color-accent-soft)" : "var(--color-bg-soft)",
          color: a ? "var(--brand-700)" : "var(--color-fg-soft)",
        }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs muted uppercase tracking-wider font-semibold truncate">{label}</div>
        <div className="text-lg font-bold truncate">{value}</div>
      </div>
    </div>
  );
}
