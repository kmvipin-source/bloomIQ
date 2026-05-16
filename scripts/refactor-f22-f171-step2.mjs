// scripts/refactor-f22-f171-step2.mjs
// F22 + F171 Step 2 — migrate 5 more admin routes off their local
// requireAdmin copies / inline platform_admin checks.
//
// Routes covered:
//   1. /api/admin/free-tier-limits/route.ts   (local requireAdmin, {ok,res})
//   2. /api/admin/plans/route.ts              (local requireAdmin, {err})
//   3. /api/admin/team/route.ts               (local requireAdmin, {error,user,sb})
//   4. /api/admin/dashboard/route.ts          (inline check)
//   5. /api/admin/super-teachers/[id]/reset-password/route.ts (inline check)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. free-tier-limits ────────────────────────────────────────────────
  {
    tag: "FTL_imports",
    file: "app/api/admin/free-tier-limits/route.ts",
    description: "Add helper import; drop now-unused getBearer/supabaseServer",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "FTL_remove_local",
    file: "app/api/admin/free-tier-limits/route.ts",
    description: "Remove local requireAdmin function",
    find: `async function requireAdmin(req: Request): Promise<{ ok: true } | { ok: false; res: Response }> {
  const token = getBearer(req);
  if (!token) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const admin = supabaseAdmin();
  const { data: prof } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!prof?.platform_admin) {
    return { ok: false, res: NextResponse.json({ error: "Platform admin only." }, { status: 403 }) };
  }
  return { ok: true };
}`,
    replace: `// F171 fix (QA): local requireAdmin removed; using shared
// requirePlatformAdmin from lib/apiAuth.ts. Call-site error shape
// changes from { ok, res } to discriminated { error } union — patches
// below adjust the two call sites accordingly.`,
  },
  // free-tier-limits has TWO call sites of the same pattern; do them with
  // enough surrounding context to disambiguate.
  {
    tag: "FTL_call1",
    file: "app/api/admin/free-tier-limits/route.ts",
    description: "Migrate first call site (GET)",
    find: `  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;

  const admin = supabaseAdmin();
  const { data: row, error } = await admin`,
    replace: `  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;

  const admin = supabaseAdmin();
  const { data: row, error } = await admin`,
  },
  {
    tag: "FTL_call2",
    file: "app/api/admin/free-tier-limits/route.ts",
    description: "Migrate second call site (PATCH)",
    find: `  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;

  let body:`,
    replace: `  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;

  let body:`,
  },

  // ─── 2. plans/route.ts ──────────────────────────────────────────────────
  {
    tag: "Plans_imports",
    file: "app/api/admin/plans/route.ts",
    description: "Add helper import; drop now-unused getBearer/supabaseServer",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Plans_remove_local",
    file: "app/api/admin/plans/route.ts",
    description: "Remove local requireAdmin function",
    find: `async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // Service-role read to dodge the RLS race. The previous user-token
  // read intermittently 403'd legit admins on the Vercel edge.
  const adminCli = supabaseAdmin();
  const { data: me } = await adminCli
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { err: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}`,
    replace: `// F171 fix (QA): local requireAdmin replaced with shared
// requirePlatformAdmin from lib/apiAuth.ts. Call sites swap
// "err" key for the discriminated "error" shape.`,
  },
  {
    tag: "Plans_call_get",
    file: "app/api/admin/plans/route.ts",
    description: "Migrate call sites that use the {err} shape",
    find: `    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;`,
    replace: `    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },

  // ─── 3. team/route.ts ───────────────────────────────────────────────────
  {
    tag: "Team_imports",
    file: "app/api/admin/team/route.ts",
    description: "Add helper import; drop now-unused getBearer/supabaseServer",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Team_remove_local",
    file: "app/api/admin/team/route.ts",
    description: "Replace local requireAdmin with shared helper alias",
    find: `async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // Service-role read avoids the RLS race that occasionally 403'd a
  // legitimate platform admin on the Vercel edge — same fix every
  // other admin route in this tree already uses.
  const adminCli = supabaseAdmin();
  const { data: me } = await adminCli
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, sb };
}`,
    replace: `// F171 fix (QA): local requireAdmin replaced with the shared
// requirePlatformAdmin from lib/apiAuth.ts. Alias kept so the existing
// three call sites need no change.
const requireAdmin = requirePlatformAdmin;`,
  },

  // ─── 4. dashboard/route.ts ──────────────────────────────────────────────
  {
    tag: "Dashboard_imports",
    file: "app/api/admin/dashboard/route.ts",
    description: "Add helper import; drop now-unused getBearer/supabaseServer",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Dashboard_inline",
    file: "app/api/admin/dashboard/route.ts",
    description: "Replace inline platform_admin check with helper call",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!prof?.platform_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const admin = supabaseAdmin();`,
    replace: `    // F171 fix (QA): inline platform_admin check replaced with shared
    // requirePlatformAdmin (and the F22 single-session iat enforcement
    // that comes with it for free).
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { admin } = auth;`,
  },

  // ─── 5. super-teachers/[id]/reset-password/route.ts ─────────────────────
  {
    tag: "SuperTeachersReset_imports",
    file: "app/api/admin/super-teachers/[id]/reset-password/route.ts",
    description: "Add helper import; drop now-unused getBearer/supabaseServer",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "SuperTeachersReset_inline",
    file: "app/api/admin/super-teachers/[id]/reset-password/route.ts",
    description: "Replace inline platform_admin check with helper call",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }`,
    replace: `    // F171 fix (QA): inline platform_admin check replaced with shared
    // helper. F22 iat enforcement now also gates this mutating route.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
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

console.log(`\n=== F22+F171 Step 2 summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
