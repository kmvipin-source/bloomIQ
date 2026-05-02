import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/student/share
 *
 * GET    — list the calling student's active (non-revoked, non-expired)
 *          share links. Used by the /student/parent UI to show what's
 *          already out there and offer revocation.
 * POST   — mint a new share link. Body: { scope?: 'mastery' | 'full' |
 *          'certificate', expiresInDays?: number }. Defaults: mastery, 30
 *          days. Returns { token, url, expires_at }.
 *
 * Auth: caller must be a signed-in student. RLS ensures they can only
 * insert/list rows where user_id = their auth.uid().
 *
 * Token format: crypto.randomUUID() — 36 chars, URL-safe, plenty of
 * entropy for a 30-day public link.
 */

async function requireStudent(req: Request) {
  const token = getBearer(req);
  if (!token) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { user, sb };
}

export async function GET(req: Request) {
  try {
    const auth = await requireStudent(req);
    if ("err" in auth) return auth.err;
    const { sb } = auth;

    // RLS limits to user's own rows.
    const { data, error } = await sb
      .from("student_share_links")
      .select("id, token, scope, created_at, expires_at, revoked_at")
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const now = Date.now();
    const links = (data || []).map((row) => ({
      ...row,
      // Convenience flag for the UI.
      is_active: !row.revoked_at && new Date(row.expires_at).getTime() > now,
    }));
    return NextResponse.json({ ok: true, links });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireStudent(req);
    if ("err" in auth) return auth.err;
    const { user, sb } = auth;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const scope =
      body.scope === "full" || body.scope === "certificate" || body.scope === "mastery"
        ? body.scope
        : "mastery";
    const expiresInDays =
      typeof body.expiresInDays === "number" && body.expiresInDays > 0
        ? Math.min(Math.floor(body.expiresInDays), 365)
        : 30;

    const newToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expiresInDays * 86400_000).toISOString();

    const { data, error } = await sb
      .from("student_share_links")
      .insert({
        token: newToken,
        user_id: user.id,
        scope,
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Build the absolute URL for convenience. Falls back to relative if
    // the host header is missing (rare but defensive).
    const host = req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    const url = host ? `${proto}://${host}/share/${newToken}` : `/share/${newToken}`;

    return NextResponse.json({
      ok: true,
      token: newToken,
      url,
      scope,
      expires_at: expiresAt,
      id: data.id,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 500 },
    );
  }
}
