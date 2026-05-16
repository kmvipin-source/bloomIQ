// app/api/student/library/route.ts
// =============================================================================
// Student question library (P1.7).
// -----------------------------------------------------------------------------
// Purpose
// -------
// Independent students who generate quizzes accumulate question_bank
// rows owned by themselves (per migration 90's category tagging and
// the existing owner_id model). They have no UI to browse those rows
// today — that's the single biggest parity gap with the teacher side.
//
// This endpoint returns paginated, filterable rows owned by the calling
// student. The /student/library page consumes it.
//
// Filters
// -------
//   - topic (case-insensitive partial match)
//   - bloom (one of the BloomLevel slugs)
//   - category (exact slug match)
//   - q (free-text — searches stem)
//   - sort: 'newest' (default) | 'oldest'
//   - limit (default 30, max 100)
//   - offset (default 0)
//
// Posture
// -------
// - RLS on question_bank already restricts to owner_id = auth.uid()
//   for students; we use the user-token client for defence-in-depth.
// - Soft-deleted rows (deleted_at NOT NULL after migration 92) are
//   excluded automatically.
// =============================================================================

import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import type { BloomLevel } from "@/lib/bloom";

export const runtime = "nodejs";

const VALID_BLOOM: ReadonlySet<BloomLevel> = new Set([
  "remember", "understand", "apply", "analyze", "evaluate", "create",
]);

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const url = new URL(req.url);
    const topic = url.searchParams.get("topic")?.trim() || "";
    const bloomRaw = url.searchParams.get("bloom")?.trim().toLowerCase() || "";
    const category = url.searchParams.get("category")?.trim() || "";
    const q = url.searchParams.get("q")?.trim() || "";
    const sort = url.searchParams.get("sort") === "oldest" ? "oldest" : "newest";
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

    let query = sb
      .from("question_bank")
      .select(
        "id, owner_id, topic, bloom_level, stem, options, correct_index, explanation, status, created_at, category, generation_meta",
        { count: "exact" },
      )
      .eq("owner_id", user.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: sort === "oldest" })
      .range(offset, offset + limit - 1);

    if (topic) query = query.ilike("topic", `%${topic}%`);
    if (bloomRaw && VALID_BLOOM.has(bloomRaw as BloomLevel)) query = query.eq("bloom_level", bloomRaw);
    if (category) query = query.eq("category", category);
    if (q) query = query.ilike("stem", `%${q}%`);

    const { data, count, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      items: data ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[student/library] unhandled:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
