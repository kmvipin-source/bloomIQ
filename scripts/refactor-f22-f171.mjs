// scripts/refactor-f22-f171.mjs
// F22 + F171 refactor — migrate the 4 admin routes that have a local
// `async function requirePlatformAdmin` to the shared helper in
// lib/apiAuth.ts. Re-runnable (skips if anchor not present).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. app/api/admin/feature-flags/route.ts ────────────────────────────
  {
    tag: "FF_route_import",
    file: "app/api/admin/feature-flags/route.ts",
    description: "Add shared-helper import; drop unused supabaseServer/getBearer",
    find: `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import {
  ALL_FLAG_NAMES,
  FLAG_REGISTRY,
  clearFlagCache,
  type PlatformFlagName,
} from "@/lib/featureFlags";`,
    replace: `import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";
import {
  ALL_FLAG_NAMES,
  FLAG_REGISTRY,
  clearFlagCache,
  type PlatformFlagName,
} from "@/lib/featureFlags";`,
  },
  {
    tag: "FF_route_remove_local",
    file: "app/api/admin/feature-flags/route.ts",
    description: "Remove the local requirePlatformAdmin function + R10 doc",
    find: `// F171 note (QA): requirePlatformAdmin is duplicated across ~10 admin
// routes. Extract to lib/adminAuth.ts (alongside the F22 single-session
// helper) and import everywhere. Single source of truth for "who is a
// platform admin" so future audit-log requirements ship in one place.
async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, admin };
}

`,
    replace: `// F171 fix (QA): local requirePlatformAdmin removed — now imported from
// lib/apiAuth.ts. Single source of truth for the platform-admin gate.

`,
  },

  // ─── 2. app/api/admin/feature-flags/overrides/route.ts ─────────────────
  {
    tag: "FF_overrides_import",
    file: "app/api/admin/feature-flags/overrides/route.ts",
    description: "Add shared-helper import",
    find: `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "FF_overrides_remove_local",
    file: "app/api/admin/feature-flags/overrides/route.ts",
    description: "Remove the local requirePlatformAdmin function",
    find: `async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, admin };
}

`,
    replace: `// F171 fix (QA): requirePlatformAdmin moved to lib/apiAuth.ts.

`,
  },

  // ─── 3. app/api/admin/users/route.ts ────────────────────────────────────
  {
    tag: "Users_route_import",
    file: "app/api/admin/users/route.ts",
    description: "Add shared-helper import",
    find: `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Users_route_remove_local",
    file: "app/api/admin/users/route.ts",
    description: "Remove the local requirePlatformAdmin function",
    find: `async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // Use the service role to read platform_admin to dodge any RLS race
  // on profiles for callers whose JWT is fresh on the edge.
  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, admin };
}

`,
    replace: `// F171 fix (QA): requirePlatformAdmin moved to lib/apiAuth.ts.

`,
  },

  // ─── 4. app/api/admin/users/[id]/route.ts ──────────────────────────────
  {
    tag: "Users_id_route_import",
    file: "app/api/admin/users/[id]/route.ts",
    description: "Add shared-helper import",
    find: `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Users_id_route_remove_local",
    file: "app/api/admin/users/[id]/route.ts",
    description: "Remove the local requirePlatformAdmin function",
    find: `async function requirePlatformAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, admin };
}

`,
    replace: `// F171 fix (QA): requirePlatformAdmin moved to lib/apiAuth.ts.

`,
  },
];

function tryReplace(content, find, replace) {
  if (content.includes(find)) {
    if (content.indexOf(find) !== content.lastIndexOf(find)) return { ok: false, reason: "find not unique (LF)" };
    return { ok: true, out: content.replace(find, replace) };
  }
  const findCrlf = find.replace(/\r?\n/g, "\r\n");
  const replaceCrlf = replace.replace(/\r?\n/g, "\r\n");
  if (content.includes(findCrlf)) {
    if (content.indexOf(findCrlf) !== content.lastIndexOf(findCrlf)) return { ok: false, reason: "find not unique (CRLF)" };
    return { ok: true, out: content.replace(findCrlf, replaceCrlf) };
  }
  return { ok: false, reason: "find pattern not present (LF or CRLF)" };
}

const applied = [];
const skipped = [];

for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  const r = tryReplace(before, fx.find, fx.replace);
  if (!r.ok) {
    skipped.push({ tag: fx.tag, reason: r.reason });
    continue;
  }
  fs.writeFileSync(abs, r.out, "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== F22+F171 refactor summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
