import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// =============================================================================
// POST /api/parent/invite        — create a new parent magic-link
// GET  /api/parent/invite        — list this student's existing links
// POST /api/parent/invite (with revoke=true) — revoke an existing link by id
//
// Uses POST for revoke as well so we don't have to fight CSRF/cache issues
// of DELETE. RLS scopes parent_invites to the student.
// =============================================================================

function newToken(): string {
  // 32 hex chars (16 bytes of randomness) — opaque, URL-safe.
  return randomBytes(16).toString("hex");
}

export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data } = await sb
      .from("parent_invites")
      .select("id, token, parent_label, parent_email, revoked_at, last_viewed_at, view_count, created_at")
      .eq("student_id", user.id)
      .order("created_at", { ascending: false });

    return NextResponse.json({ ok: true, invites: data || [] });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));

    // Revoke path
    if (body.revoke === true) {
      const id = String(body.id || "");
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { error: upErr } = await sb
        .from("parent_invites")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .eq("student_id", user.id);
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      return NextResponse.json({ ok: true, revoked: true });
    }

    // Create path
    const parent_label: string | null = typeof body.parent_label === "string" && body.parent_label.trim()
      ? body.parent_label.trim().slice(0, 40) : null;
    const parent_email: string | null = typeof body.parent_email === "string" && body.parent_email.trim()
      ? body.parent_email.trim().slice(0, 200) : null;

    // Hard cap: max 5 active (non-revoked) invites per student so we don't
    // accumulate orphan links.
    const { count: activeCount } = await sb
      .from("parent_invites")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .is("revoked_at", null);
    if ((activeCount || 0) >= 5) {
      return NextResponse.json(
        { error: "You have 5 active parent links — revoke one before creating another." },
        { status: 400 }
      );
    }

    const token = newToken();
    const { data: row, error: insErr } = await sb
      .from("parent_invites")
      .insert({ student_id: user.id, token, parent_label, parent_email })
      .select("id, token, parent_label, parent_email, created_at")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, invite: row });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invite failed" },
      { status: 500 }
    );
  }
}
