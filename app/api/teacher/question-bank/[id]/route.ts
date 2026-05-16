import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * PATCH /api/teacher/question-bank/[id]
 *
 * Updates the caller's own question_bank row via the service role.
 * Mirrors the DELETE pattern below. The /teacher/review page used to
 * write directly with the user-token client (approve / reject / save
 * edits), which raced RLS the same way the read + delete paths did.
 *
 * Body: { stem?, options?, correct_index?, explanation?, status? }
 *   - status must be one of 'pending'|'approved'|'rejected'.
 *   - Unknown keys are ignored (not forwarded to the update).
 *
 * Caller identity verified via supabaseServer(token).auth.getUser().
 * Service-role write is gated on owner_id = caller.
 */
const ALLOWED_FIELDS = new Set([
  "stem",
  "options",
  "correct_index",
  "explanation",
  "status",
]);
const ALLOWED_STATUS = new Set(["pending", "approved", "rejected"]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing question id" }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (!ALLOWED_FIELDS.has(key)) continue;
      if (key === "status" && !ALLOWED_STATUS.has(body[key])) {
        return NextResponse.json({ error: `Invalid status: ${body[key]}` }, { status: 400 });
      }
      patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { error } = await admin
      .from("question_bank")
      .update(patch)
      .eq("id", id)
      .eq("owner_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/teacher/question-bank/[id]
 *
 * Deletes the caller's own question_bank row via the service role. The
 * /teacher/quizzes/new page used to hit question_bank directly with the
 * user-token client, which raced RLS the same way the GET path did. The
 * companion GET route already exists; this is the matching write path.
 *
 * Caller identity is verified via supabaseServer(token).auth.getUser().
 * The service-role delete is gated on owner_id = caller, so it never
 * widens write access beyond what the RLS policy already grants.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing question id" }, { status: 400 });

    const admin = supabaseAdmin();
    const { error } = await admin
      .from("question_bank")
      .delete()
      .eq("id", id)
      .eq("owner_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 }
    );
  }
}
