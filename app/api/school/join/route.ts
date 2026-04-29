import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

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

    const { data: prof } = await sb.from("profiles").select("role, school_id").eq("id", user.id).single();
    if (!prof || prof.role !== "teacher") {
      return NextResponse.json({ error: "Only teachers can join a school." }, { status: 403 });
    }
    if (prof.school_id) {
      return NextResponse.json({ error: "You're already in a school. Leave it first to switch." }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return NextResponse.json({ error: "Enter the school code." }, { status: 400 });

    const admin = supabaseAdmin();
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
    const { error } = await admin.from("profiles").update({ school_id: null }).eq("id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
