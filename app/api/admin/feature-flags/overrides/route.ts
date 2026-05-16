import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";
import {
  ALL_FLAG_NAMES,
  clearFlagCache,
  type PlatformFlagName,
} from "@/lib/featureFlags";

export const runtime = "nodejs";

/**
 * /api/admin/feature-flags/overrides
 *
 *   GET    -> list active overrides for one flag, with school/user names
 *             joined in for display.
 *   POST   -> add or upsert an override:
 *               { flag, entity_type, entity_id, enabled, note, expires_at? }
 *             Default expires_at = today + 90 days (configurable per call).
 *             Pass expires_at = null in the body to make a permanent
 *             override (we explicitly require the operator to think
 *             about expiry — no silent permanents).
 *   DELETE -> remove an override:
 *               { flag, entity_type, entity_id }
 *
 * All actions audit-logged.
 */

const DEFAULT_EXPIRY_DAYS = 90;

// F171 fix (QA): requirePlatformAdmin moved to lib/apiAuth.ts.

function validateFlag(name: string): PlatformFlagName | null {
  return ALL_FLAG_NAMES.includes(name as PlatformFlagName)
    ? (name as PlatformFlagName)
    : null;
}

// F8 fix: validate entity_id is a UUID before sending to Postgres,
// otherwise a bad input surfaces as a noisy 500 with PG-internal error
// text ("invalid input syntax for type uuid").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export async function GET(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { admin } = auth;

  const url = new URL(req.url);
  const flag = validateFlag(url.searchParams.get("flag") || "");
  if (!flag) {
    return NextResponse.json({ error: "Unknown or missing 'flag' query." }, { status: 400 });
  }

  const { data, error } = await admin
    .from("platform_flag_overrides")
    .select("flag_name, entity_type, entity_id, enabled, note, added_at, added_by, expires_at")
    .eq("flag_name", flag)
    .order("added_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Hydrate display names for school overrides; user overrides stay
  // anonymous in the UI (just show the uuid) — we don't want a casual
  // admin-team viewer to see who's getting flagged-on demos.
  const schoolIds = (data || [])
    .filter((r) => r.entity_type === "school")
    .map((r) => r.entity_id);
  let schoolNames = new Map<string, string>();
  if (schoolIds.length > 0) {
    const { data: schools } = await admin
      .from("schools")
      .select("id, name")
      .in("id", schoolIds);
    schoolNames = new Map((schools || []).map((s) => [s.id as string, (s.name || "(unnamed)") as string]));
  }

  const now = Date.now();
  const rows = (data || []).map((r) => ({
    ...r,
    expired: r.expires_at ? new Date(r.expires_at).getTime() < now : false,
    display_name:
      r.entity_type === "school"
        ? schoolNames.get(r.entity_id) || "(unknown school)"
        : "(user)",
  }));

  return NextResponse.json({ overrides: rows });
}

export async function POST(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { user, admin } = auth;

  const body = await req.json().catch(() => ({}));
  const flag = validateFlag(String(body.flag || ""));
  const entityType = String(body.entity_type || "");
  const entityId = String(body.entity_id || "").trim();
  const enabled = body.enabled;
  const note = String(body.note || "").trim();

  if (!flag) return NextResponse.json({ error: "Unknown flag." }, { status: 400 });
  if (entityType !== "school" && entityType !== "user") {
    return NextResponse.json(
      { error: "entity_type must be 'school' or 'user'." },
      { status: 400 }
    );
  }
  if (!entityId) {
    return NextResponse.json({ error: "entity_id is required." }, { status: 400 });
  }
  if (!isUuid(entityId)) {
    return NextResponse.json(
      { error: "entity_id must be a UUID (32 hex digits separated by dashes)." },
      { status: 400 }
    );
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
  }
  if (!note) {
    // Force operators to write down WHY a school is on the allowlist.
    // Saves a lot of pain six months later when nobody remembers.
    return NextResponse.json(
      { error: "A short reason ('note') is required for every override." },
      { status: 400 }
    );
  }

  // Validate the entity actually exists. Avoids stranded overrides
  // pointing at deleted rows.
  if (entityType === "school") {
    const { data: school } = await admin
      .from("schools")
      .select("id")
      .eq("id", entityId)
      .maybeSingle();
    if (!school) {
      return NextResponse.json({ error: "No school with that id." }, { status: 404 });
    }
  } else {
    const { data: u } = await admin.auth.admin.getUserById(entityId).catch(() => ({ data: null }));
    if (!u || !("user" in u) || !u.user) {
      return NextResponse.json({ error: "No user with that id." }, { status: 404 });
    }
  }

  // Default expiry = 90 days unless caller passed an explicit value (or
  // explicit null for "no expiry"). Operator has to opt in to permanent.
  let expiresAt: string | null;
  if (Object.prototype.hasOwnProperty.call(body, "expires_at")) {
    expiresAt = body.expires_at == null ? null : String(body.expires_at);
  } else {
    const d = new Date();
    d.setDate(d.getDate() + DEFAULT_EXPIRY_DAYS);
    expiresAt = d.toISOString();
  }

  const { data: before } = await admin
    .from("platform_flag_overrides")
    .select("enabled, note, expires_at")
    .eq("flag_name", flag)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle();

  const { error } = await admin.from("platform_flag_overrides").upsert(
    {
      flag_name: flag,
      entity_type: entityType,
      entity_id: entityId,
      enabled,
      note,
      added_by: user.id,
      added_at: new Date().toISOString(),
      expires_at: expiresAt,
    },
    { onConflict: "flag_name,entity_type,entity_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("platform_flag_audit").insert({
    flag_name: flag,
    action: before ? "update_override" : "add_override",
    actor_id: user.id,
    entity_type: entityType,
    entity_id: entityId,
    before_state: before
      ? { enabled: before.enabled, note: before.note, expires_at: before.expires_at }
      : null,
    after_state: { enabled, note, expires_at: expiresAt },
    reason: note,
  });

  clearFlagCache(flag);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { user, admin } = auth;

  const body = await req.json().catch(() => ({}));
  const flag = validateFlag(String(body.flag || ""));
  const entityType = String(body.entity_type || "");
  const entityId = String(body.entity_id || "").trim();
  const reason = String(body.reason || "").trim();

  if (!flag) return NextResponse.json({ error: "Unknown flag." }, { status: 400 });
  if (entityType !== "school" && entityType !== "user") {
    return NextResponse.json(
      { error: "entity_type must be 'school' or 'user'." },
      { status: 400 }
    );
  }
  if (!entityId) {
    return NextResponse.json({ error: "entity_id is required." }, { status: 400 });
  }
  if (!isUuid(entityId)) {
    return NextResponse.json(
      { error: "entity_id must be a UUID." },
      { status: 400 }
    );
  }

  const { data: before } = await admin
    .from("platform_flag_overrides")
    .select("enabled, note, expires_at")
    .eq("flag_name", flag)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle();

  if (!before) {
    return NextResponse.json({ ok: true, noop: true });
  }

  const { error } = await admin
    .from("platform_flag_overrides")
    .delete()
    .eq("flag_name", flag)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("platform_flag_audit").insert({
    flag_name: flag,
    action: "remove_override",
    actor_id: user.id,
    entity_type: entityType,
    entity_id: entityId,
    before_state: { enabled: before.enabled, note: before.note, expires_at: before.expires_at },
    after_state: null,
    reason,
  });

  clearFlagCache(flag);
  return NextResponse.json({ ok: true });
}

  