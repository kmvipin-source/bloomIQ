import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";
import {
  ALL_FLAG_NAMES,
  FLAG_REGISTRY,
  clearFlagCache,
  type PlatformFlagName,
} from "@/lib/featureFlags";

export const runtime = "nodejs";

/**
 * /api/admin/feature-flags
 *
 *   GET  -> list every known flag with its current global_default,
 *           description, last-updated metadata, and a count of active
 *           overrides per flag. Powers the admin dashboard.
 *
 *   POST -> { name, global_default, reason } toggles the global default
 *           for one flag and writes an audit row.
 *
 * Both gated by platform_admin. Service-role read avoids the RLS race
 * that other admin routes in this tree have already documented.
 */

// F171 fix (QA): local requirePlatformAdmin removed — now imported from
// lib/apiAuth.ts. Single source of truth for the platform-admin gate.

export async function GET(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { admin } = auth;

  const { data: flagRows, error: flagErr } = await admin
    .from("platform_flags")
    .select("name, global_default, description, updated_at, updated_by");
  if (flagErr) {
    return NextResponse.json({ error: flagErr.message }, { status: 500 });
  }

  const { data: overrideRows, error: ovErr } = await admin
    .from("platform_flag_overrides")
    .select("flag_name, entity_type, expires_at");
  if (ovErr) {
    return NextResponse.json({ error: ovErr.message }, { status: 500 });
  }

  const now = Date.now();
  const counts = new Map<string, { schools: number; users: number }>();
  for (const r of overrideRows || []) {
    const key = r.flag_name as string;
    if (r.expires_at && new Date(r.expires_at).getTime() < now) continue;
    if (!counts.has(key)) counts.set(key, { schools: 0, users: 0 });
    const c = counts.get(key)!;
    if (r.entity_type === "school") c.schools += 1;
    else if (r.entity_type === "user") c.users += 1;
  }

  // Merge what's in the DB with what's in the code registry so the UI
  // can flag any DB-only orphans (legacy flags) AND any code-only flags
  // missing from the DB (forgot to run the seed migration).
  const byName = new Map((flagRows || []).map((r) => [r.name as string, r]));
  const merged = ALL_FLAG_NAMES.map((name) => {
    const dbRow = byName.get(name);
    const c = counts.get(name) || { schools: 0, users: 0 };
    return {
      name,
      registered: true,
      inDb: !!dbRow,
      globalDefault: dbRow ? !!dbRow.global_default : FLAG_REGISTRY[name].safeDefault,
      description: dbRow?.description || FLAG_REGISTRY[name].description,
      safeDefault: FLAG_REGISTRY[name].safeDefault,
      publicReadable: FLAG_REGISTRY[name].publicReadable,
      updatedAt: dbRow?.updated_at || null,
      updatedBy: dbRow?.updated_by || null,
      activeSchoolOverrides: c.schools,
      activeUserOverrides: c.users,
      envOverrideName: `FLAG_${name.toUpperCase()}`,
      envOverrideValue: process.env[`FLAG_${name.toUpperCase()}`] ?? null,
    };
  });

  // Surface any DB-only orphans separately — the admin can decide whether
  // to delete them or add them to the registry.
  const orphans = (flagRows || [])
    .filter((r) => !ALL_FLAG_NAMES.includes(r.name as PlatformFlagName))
    .map((r) => ({
      name: r.name,
      registered: false,
      inDb: true,
      globalDefault: !!r.global_default,
      description: r.description || "",
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));

  return NextResponse.json({ flags: merged, orphans });
}

export async function POST(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { user, admin } = auth;

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const globalDefault = body.global_default;
  const reason = String(body.reason || "").trim();

  if (!name) {
    return NextResponse.json({ error: "Flag name is required." }, { status: 400 });
  }
  if (typeof globalDefault !== "boolean") {
    return NextResponse.json(
      { error: "global_default must be a boolean." },
      { status: 400 }
    );
  }
  if (!ALL_FLAG_NAMES.includes(name as PlatformFlagName)) {
    return NextResponse.json(
      { error: `Unknown flag '${name}'. Add it to FLAG_REGISTRY first.` },
      { status: 400 }
    );
  }
  // F11 fix: every flip must carry a reason. Three months later the
  // audit log without a reason is useless. Mirrors the same requirement
  // already enforced on /overrides POST.
  if (!reason) {
    return NextResponse.json(
      { error: "A short reason for the flip is required (it goes into the audit log)." },
      { status: 400 }
    );
  }

  // Read the current value for the audit trail.
  const { data: before } = await admin
    .from("platform_flags")
    .select("global_default")
    .eq("name", name)
    .maybeSingle();

  // F5 note (QA): no optimistic-concurrency check between the SELECT
  // above and the UPDATE below. Two admins flipping the same flag in
  // the same second can race; the later writer wins silently. To gate,
  // add .eq("updated_at", before.updated_at) on the UPDATE and 409 if
  // 0 rows. Low-frequency operation, but worth tightening pre-pilot.
  if (before && before.global_default === globalDefault) {
    return NextResponse.json({
      ok: true,
      noop: true,
      message: "Already in that state — no change written.",
    });
  }

  const { error: upErr } = await admin
    .from("platform_flags")
    .update({
      global_default: globalDefault,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("name", name);

  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  // F12 fix: best-effort audit insert with a loud warn on failure so
  // ops can spot a missing trail. True atomicity requires wrapping
  // UPDATE + INSERT in an RPC — deferred to a follow-up migration.
  const auditRes = await admin.from("platform_flag_audit").insert({
    flag_name: name,
    action: "set_default",
    actor_id: user.id,
    before_state: before ? { global_default: before.global_default } : null,
    after_state: { global_default: globalDefault },
    reason,
  });
  if (auditRes.error) {
    // eslint-disable-next-line no-console
    console.error("[feature-flags] AUDIT INSERT FAILED:", auditRes.error.message);
  }

  clearFlagCache(name as PlatformFlagName);
  return NextResponse.json({ ok: true });
}
