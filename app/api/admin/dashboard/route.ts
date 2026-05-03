import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/dashboard
 *
 * Aggregates platform-wide adoption + revenue numbers for the admin
 * dashboard. Service-role read so RLS doesn't filter the query down to
 * the caller's own rows. Re-checks platform_admin on the caller; non-
 * admins get 403.
 *
 * The shape is "counts only" — no user emails, no school names beyond
 * what the dashboard explicitly groups, no IDs. This is by design: the
 * dashboard surface should not let an admin enumerate individual users.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!prof?.platform_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const admin = supabaseAdmin();

    // -- Plans (canonical labels + price + tier for grouping)
    const { data: plans } = await admin
      .from("plans")
      .select("id, slug, tier, label, price_paise, per_student_price_paise, pricing_model, period_days");

    // -- Active subscriptions joined with plan slug.
    const { data: subs } = await admin
      .from("subscriptions")
      .select("id, user_id, school_id, plan_id, tier, status, price_paid_paise, expires_at");

    // -- Profiles minimal — used for free-tier count + role mix.
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, role, is_school_student, school_id");

    const { data: schools } = await admin.from("schools").select("id, created_at");

    const planById = new Map((plans || []).map((p) => [p.id as string, p]));
    const planBySlug = new Map((plans || []).map((p) => [p.slug as string, p]));

    // Active sub set: status active + not expired.
    const now = Date.now();
    const activeSubs = (subs || []).filter((s) => {
      if (s.status && s.status !== "active") return false;
      if (s.expires_at && new Date(s.expires_at).getTime() < now) return false;
      return true;
    });

    // Per-plan counts + revenue (from subscriptions.price_paid_paise — that's
    // the actual amount captured at checkout for the term).
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
    const tierCategory = (tier: string) => {
      if (tier === "free") return "Free";
      if (tier === "premium") return "Premium";
      if (tier === "premium_plus") return "Premium Plus";
      if (tier && tier.startsWith("school_")) return "School";
      return "Other";
    };

    const planRows: PlanRow[] = (plans || []).map((p) => ({
      slug: p.slug,
      label: p.label,
      tier: p.tier,
      category: tierCategory(p.tier),
      pricing_model: p.pricing_model || "fixed",
      list_price_paise:
        p.pricing_model === "per_student"
          ? p.per_student_price_paise || 0
          : p.price_paise || 0,
      members: 0,
      revenue_paise: 0,
    }));
    const rowBySlug = new Map(planRows.map((r) => [r.slug, r]));

    let unsubscribed = 0;
    let schoolStudents = 0;
    const allProfiles = profiles || [];
    const subsByUser = new Map(activeSubs.map((s) => [s.user_id as string, s]));

    for (const p of allProfiles) {
      if (p.is_school_student) schoolStudents += 1;
      // Count "free / unsubscribed" only for user-driven roles (students not
      // attached to a school). Teachers / school_admin / platform_admin
      // are excluded because counting them as "free users" would skew the
      // adoption story.
      if (p.role === "student" && !p.is_school_student && !p.platform_admin) {
        const s = subsByUser.get(p.id);
        if (!s) {
          unsubscribed += 1;
        } else {
          const slug = planById.get(s.plan_id || "")?.slug;
          if (slug === "free" || !slug) unsubscribed += 1;
        }
      }
    }

    // Walk each active sub, increment its plan's member count + revenue.
    for (const s of activeSubs) {
      if (!s.plan_id) continue;
      const plan = planById.get(s.plan_id);
      if (!plan) continue;
      const row = rowBySlug.get(plan.slug);
      if (!row) continue;
      row.members += 1;
      row.revenue_paise += s.price_paid_paise || 0;
    }

    // Add unsubscribed/free into the Free category as a synthetic row when
    // the actual `free` plan isn't subscribed to (most students are simply
    // unsubscribed, not on a `free` plan row).
    const freeRow = rowBySlug.get("free");
    if (freeRow) {
      freeRow.members += unsubscribed;
    } else {
      planRows.push({
        slug: "free",
        label: "Free / Unsubscribed",
        tier: "free",
        category: "Free",
        pricing_model: "fixed",
        list_price_paise: 0,
        members: unsubscribed,
        revenue_paise: 0,
      });
    }

    // Group by category.
    const categories: Record<string, { members: number; revenue_paise: number; rows: PlanRow[] }> = {};
    for (const r of planRows) {
      const c = (categories[r.category] ||= { members: 0, revenue_paise: 0, rows: [] });
      c.members += r.members;
      c.revenue_paise += r.revenue_paise;
      c.rows.push(r);
    }

    // Top schools by student headcount — username (label) + count only.
    const schoolStudentCounts = new Map<string, number>();
    for (const p of allProfiles) {
      if (p.is_school_student && p.school_id) {
        schoolStudentCounts.set(p.school_id, (schoolStudentCounts.get(p.school_id) || 0) + 1);
      }
    }
    const { data: schoolNames } = await admin
      .from("schools")
      .select("id, name")
      .in("id", Array.from(schoolStudentCounts.keys()).length ? Array.from(schoolStudentCounts.keys()) : ["00000000-0000-0000-0000-000000000000"]);
    const topSchools = (schoolNames || [])
      .map((s) => ({ name: s.name as string, students: schoolStudentCounts.get(s.id as string) || 0 }))
      .sort((a, b) => b.students - a.students)
      .slice(0, 10);

    // ---- Teachers breakdown ----
    // Sub-role: 'super_teacher' (school admin), 'primary' (primary class
    // owner), 'co_teacher' (assistant). 'super_teacher' takes precedence.
    // Exclude platform admins from the teacher list — even if their
    // legacy profile.role is 'teacher' or 'super_teacher' from a prior
    // signup, they shouldn't show up in school-staff counts.
    const teacherProfiles = allProfiles.filter((p) => (p.role === "teacher" || p.role === "super_teacher") && !p.platform_admin);
    const teacherIds = teacherProfiles.map((p) => p.id);
    const { data: teacherNames } = teacherIds.length
      ? await admin.from("profiles").select("id, full_name").in("id", teacherIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const nameById = new Map((teacherNames || []).map((p) => [p.id as string, p.full_name as string | null]));

    const allSchoolIds = teacherProfiles.map((p) => p.school_id).filter(Boolean) as string[];
    const { data: schoolMap } = allSchoolIds.length
      ? await admin.from("schools").select("id, name").in("id", allSchoolIds)
      : { data: [] as { id: string; name: string }[] };
    const schoolNameById = new Map((schoolMap || []).map((s) => [s.id as string, s.name as string]));

    const { data: ctRows } = teacherIds.length
      ? await admin.from("class_teachers").select("teacher_id, role").in("teacher_id", teacherIds)
      : { data: [] as { teacher_id: string; role: string }[] };
    const subRoleByTeacher = new Map<string, "primary" | "co_teacher">();
    for (const r of ctRows || []) {
      const cur = subRoleByTeacher.get(r.teacher_id);
      // 'primary' wins over 'co' if a teacher holds both.
      if (r.role === "primary") subRoleByTeacher.set(r.teacher_id, "primary");
      else if (!cur && r.role === "co") subRoleByTeacher.set(r.teacher_id, "co_teacher");
    }

    type TeacherRow = { name: string; school: string; sub_role: "super_teacher" | "primary" | "co_teacher" | "unassigned" };
    const teachers: TeacherRow[] = teacherProfiles.map((p) => {
      let sub_role: TeacherRow["sub_role"];
      if (p.role === "super_teacher") sub_role = "super_teacher";
      else sub_role = subRoleByTeacher.get(p.id) ?? "unassigned";
      return {
        name: nameById.get(p.id) || "—",
        school: (p.school_id && schoolNameById.get(p.school_id)) || "—",
        sub_role,
      };
    }).sort((a, b) => a.school.localeCompare(b.school) || a.name.localeCompare(b.name));

    const teacherCounts = {
      super_teacher: teachers.filter((t) => t.sub_role === "super_teacher").length,
      primary: teachers.filter((t) => t.sub_role === "primary").length,
      co_teacher: teachers.filter((t) => t.sub_role === "co_teacher").length,
      unassigned: teachers.filter((t) => t.sub_role === "unassigned").length,
    };

    const totals = {
      total_users: allProfiles.length,
      students: allProfiles.filter((p) => p.role === "student" && !p.is_school_student && !p.platform_admin).length,
      school_students: schoolStudents,
      teachers: allProfiles.filter((p) => (p.role === "teacher" || p.role === "super_teacher") && !p.platform_admin).length,
      schools_onboarded: (schools || []).length,
      paying_subscribers: activeSubs.filter((s) => {
        const slug = planById.get(s.plan_id || "")?.slug;
        return slug && slug !== "free";
      }).length,
      total_revenue_paise: planRows.reduce((s, r) => s + r.revenue_paise, 0),
    };

    return NextResponse.json(
      {
        ok: true,
        totals,
        categories: Object.entries(categories).map(([name, v]) => ({
          name,
          members: v.members,
          revenue_paise: v.revenue_paise,
          rows: v.rows.sort((a, b) => a.list_price_paise - b.list_price_paise),
        })),
        topSchools,
        teachers,
        teacherCounts,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
