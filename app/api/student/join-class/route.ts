import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/student/join-class
 * Body: { code: string }
 *
 * Server-mediated class-by-code lookup so we can drop the open
 * `classes read by code` RLS policy (RLS_AUDIT.md MEDIUM finding —
 * exposes every class row + join_code to every authenticated user).
 *
 * Flow:
 *   - require auth bearer
 *   - admin client looks up class with matching join_code
 *   - admin client inserts class_members row (idempotent — PK conflict = OK)
 *   - returns { id, name } so the UI can show "Joined <name>"
 */
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim().toUpperCase();
    if (!code || code.length < 4 || code.length > 16) {
      return NextResponse.json({ error: "Enter the class code." }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: cls } = await admin
      .from("classes")
      .select("id, name, school_id")
      .eq("join_code", code)
      .maybeSingle();
    if (!cls) {
      return NextResponse.json({ error: "No class found with that code." }, { status: 404 });
    }

    // Insert membership (idempotent — duplicate is treated as already-joined).
    const { error: memErr } = await admin
      .from("class_members")
      .insert({ class_id: cls.id, student_id: user.id });
    if (memErr && !memErr.message.toLowerCase().includes("duplicate")) {
      return NextResponse.json({ error: memErr.message }, { status: 500 });
    }
    const alreadyMember = !!memErr;

    return NextResponse.json({
      ok: true,
      alreadyMember,
      class: { id: cls.id, name: cls.name },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
