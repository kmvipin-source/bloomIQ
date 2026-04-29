import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

function clientIp(req: Request): string | null {
  // Standard proxy headers; fall back to the Vercel-specific one
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  return null;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ip = clientIp(req);
    const ua = req.headers.get("user-agent") || null;

    // Service-role insert — login audit is append-only and not user-writable.
    // Best-effort: an audit failure must NEVER block a successful sign-in, so
    // we swallow any error here (FK race, RLS hiccup, transient DB issue) and
    // return 200. The client only fires this in the background anyway.
    try {
      const admin = supabaseAdmin();
      await admin.from("student_logins").insert({
        user_id: user.id,
        ip,
        user_agent: ua,
      });
    } catch { /* best-effort audit; never block login */ }

    return NextResponse.json({ ok: true });
  } catch {
    // Even the outer path must not surface a 500 to the client — the user is
    // already signed in, audit is non-essential.
    return NextResponse.json({ ok: true });
  }
}
