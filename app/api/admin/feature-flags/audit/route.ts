import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/admin/feature-flags/audit?flag=<name>&limit=50
 *
 * Returns the most recent audit rows. If `flag` is omitted, returns the
 * cross-flag firehose. Limit clamped 1..200, default 50.
 */
export async function GET(req: Request) {
  // F171 fix (QA): inline check → shared helper.
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { admin } = auth;

  const url = new URL(req.url);
  const flag = url.searchParams.get("flag");
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));

  let q = admin
    .from("platform_flag_audit")
    .select("id, flag_name, action, actor_id, entity_type, entity_id, before_state, after_state, reason, at")
    .order("at", { ascending: false })
    .limit(limit);
  if (flag) q = q.eq("flag_name", flag);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Hydrate actor names so the UI shows "Vipin K." instead of a uuid.
  const actorIds = Array.from(
    new Set((data || []).map((r) => r.actor_id).filter(Boolean) as string[])
  );
  let actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: profs } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", actorIds);
    actorNames = new Map(
      (profs || []).map((p) => [p.id as string, (p.full_name || "(unknown)") as string])
    );
  }

  const rows = (data || []).map((r) => ({
    ...r,
    actor_name: r.actor_id ? actorNames.get(r.actor_id) || "(unknown)" : "(system)",
  }));

  return NextResponse.json({ entries: rows });
}
