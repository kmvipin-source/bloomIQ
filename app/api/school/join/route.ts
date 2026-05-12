import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Simple in-memory rate limiter for /api/school/join POST. A 6-char
// join code is brute-forceable in seconds without a throttle. We allow
// 8 attempts per user per 10 minutes; further attempts return 429.
// Lives for the lifetime of the Vercel function instance — adequate
// for the threat model (deter a single noisy session). Distributed
// rate-limiting (Redis / Upstash) is a follow-up if abuse appears.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 8;
const attemptsByUser = new Map<string, number[]>();
function shouldThrottle(userId: string): boolean {
  const now = Date.now();
  const recent = (attemptsByUser.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    attemptsByUser.set(userId, recent);
    return true;
  }
  recent.push(now);
  attemptsByUser.set(userId, recent);
  return false;
}

/**
 * POST /api/school/join
 * Body: { code: string }
 * A teacher with no school_id joins the school whose join_code matches.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (shouldThrottle(user.id)) {
      return NextResponse.json(
        { error: "Too many join attempts. Wait a few minutes and try again." },
        { status: 429 }
      );
    }

    const admin = supabaseAdmin();
    const { data: prof } = await admin.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
    if (!prof || prof.role !== "teacher") {
      return NextResponse.json({ error: "Only teachers can join a school." }, { status: 403 });
    }
    if (prof.school_id) {
      return NextResponse.json({ error: "You're already in a school. Leave it first to switch." }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return NextResponse.json({ error: "Enter the school code." }, { status: 400 });

    const { data: school } = await admin
      .from("schools")
      .select("id, name")
      .eq("join_code", code)
      .maybeSingle();
    if (!school) return NextResponse.json({ error: "No school found with that code." }, { status: 404 });

    const { error } = await admin.from("profiles").update({ school_id: school.id }).eq("id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, school });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/school/join
 * Teacher leaves their current school.
 */
export async function DELETE(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb.from("profiles").select("role, school_id").eq("id", user.id).single();
    if (!prof || prof.role !== "teacher") {
      return NextResponse.json({ error: "Only teachers can leave a school." }, { status: 403 });
    }
    if (!prof.school_id) {
      return NextResponse.json({ error: "Not in a school." }, { status: 400 });
    }
    const admin = supabaseAdmin();

    // Detach this teacher from any class in the school they're leaving:
    //   - drop their class_teachers rows for those classes
    //   - clear classes.owner_id where it pointed to them
    // The CLASSES themselves stay so the super_teacher can reassign a new
    // primary later.
    const { data: classesInSchool } = await admin
      .from("classes")
      .select("id, owner_id")
      .eq("school_id", prof.school_id);
    const classIds = (classesInSchool || []).map((c) => c.id);
    if (classIds.length) {
      await admin
        .from("class_teachers")
        .delete()
        .eq("teacher_id", user.id)
        .in("class_id", classIds);
      const ownedIds = (classesInSchool || []).filter((c) => c.owner_id === user.id).map((c) => c.id);
      if (ownedIds.length) {
        await admin
          .from("classes")
          .update({ owner_id: null })
          .in("id", ownedIds);
      }
    }

    // Drop any pending teacher invites that targeted this teacher's email
    // for classes in this school (defensive — invites should already be
    // cleared once they joined; covers stale data).
    const { data: authUser } = await admin.auth.admin.getUserById(user.id);
    const teacherEmail = authUser?.user?.email?.toLowerCase();
    if (teacherEmail && classIds.length) {
      await admin
        .from("class_teacher_invites")
        .delete()
        .eq("email", teacherEmail)
        .in("class_id", classIds);
    }

    const { error } = await admin.from("profiles").update({ school_id: null }).eq("id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
