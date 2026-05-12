import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateQuizCode } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/school/create
 *
 * Creates a new school and binds the caller as its Admin Head via a
 * single service-role transaction. The previous client-side flow ran
 * the schools insert + profiles update separately with the user-token
 * client and ignored the second op's error — a partial failure left an
 * orphan school the admin couldn't access.
 *
 * Body: { name: string }
 * Auth: bearer token required. Caller's profile must not already be
 * bound to a school.
 *
 * join_code allocation retries on Postgres unique-violation (23505) so
 * a collision with another concurrent create doesn't surface as a 500.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    if (!name) return NextResponse.json({ error: "School name is required" }, { status: 400 });

    const admin = supabaseAdmin();

    // Refuse if the caller already belongs to a school — Heads bind to
    // exactly one school. Multi-school admins use the platform-admin
    // surface instead.
    const { data: prof } = await admin
      .from("profiles")
      .select("school_id")
      .eq("id", user.id)
      .maybeSingle();
    if ((prof as { school_id?: string | null } | null)?.school_id) {
      return NextResponse.json({ error: "You are already in a school." }, { status: 409 });
    }

    // Allocate a join code with retry on unique violation.
    let schoolId: string | null = null;
    let lastErr: { message?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateQuizCode();
      const { data: sch, error } = await admin
        .from("schools")
        .insert({
          name,
          super_teacher_id: user.id,
          join_code: candidate,
        })
        .select("id")
        .single();
      if (!error && sch) {
        schoolId = (sch as { id: string }).id;
        break;
      }
      lastErr = error as { message?: string; code?: string } | null;
      if (lastErr?.code !== "23505") break; // non-collision error, give up
    }
    if (!schoolId) {
      return NextResponse.json(
        { error: `Could not create school: ${lastErr?.message || "unknown error"}` },
        { status: 500 }
      );
    }

    const { error: profErr } = await admin
      .from("profiles")
      .update({ school_id: schoolId })
      .eq("id", user.id);
    if (profErr) {
      // Compensating delete so the orphan school doesn't survive a
      // failed bind. Without this rollback the caller would see
      // "Set up your school" on retry yet the schools row would still
      // be there with their user id as super_teacher_id.
      await admin.from("schools").delete().eq("id", schoolId);
      return NextResponse.json({ error: profErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, school_id: schoolId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
