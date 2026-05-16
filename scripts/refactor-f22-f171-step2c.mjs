// scripts/refactor-f22-f171-step2c.mjs
// F22 + F171 Step 2c — 5 more admin routes onto the shared helper.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. schools/[id]/invoices.csv/route.ts ──────────────────────────────
  {
    tag: "Invoices_imports",
    file: "app/api/admin/schools/[id]/invoices.csv/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Invoices_inline",
    file: "app/api/admin/schools/[id]/invoices.csv/route.ts",
    description: "Replace inline check with helper",
    find: `  const token = getBearer(req);
  if (!token) return new Response("Unauthorized", { status: 401 });
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { data: prof } = await sb
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!prof?.platform_admin) return new Response("Forbidden", { status: 403 });`,
    replace: `  // F171 fix (QA): inline platform_admin check → shared helper.
  // Helper returns JSON error responses (not plain-text Response). CSV
  // consumers will see {"error":"Unauthorized"} on 401 / Forbidden on 403
  // instead of plain text; clients should parse status code, not body.
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;`,
  },

  // ─── 2. subscriptions/[id]/reactivate/route.ts ──────────────────────────
  {
    tag: "Reactivate_imports",
    file: "app/api/admin/subscriptions/[id]/reactivate/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Reactivate_inline",
    file: "app/api/admin/subscriptions/[id]/reactivate/route.ts",
    description: "Replace inline check with helper",
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
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },

  // ─── 3. subscriptions/[id]/suspend/route.ts ─────────────────────────────
  {
    tag: "Suspend_imports",
    file: "app/api/admin/subscriptions/[id]/suspend/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Suspend_inline",
    file: "app/api/admin/subscriptions/[id]/suspend/route.ts",
    description: "Replace inline check with helper",
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
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },

  // ─── 4. subscriptions/[id]/invoice/route.ts ─────────────────────────────
  // This route uses NextResponse but imports getBearer/supabaseServer.
  // Let's check the import line first — it's likely the same standard pattern.
  {
    tag: "Invoice_imports",
    file: "app/api/admin/subscriptions/[id]/invoice/route.ts",
    description: "Add helper import (preserving existing supabase/server import shape)",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Invoice_inline",
    file: "app/api/admin/subscriptions/[id]/invoice/route.ts",
    description: "Replace inline check with helper (note: this route uses .single() not maybeSingle)",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .single();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }`,
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },

  // ─── 5. team/sign-in-link/route.ts ──────────────────────────────────────
  {
    tag: "SignInLink_imports",
    file: "app/api/admin/team/sign-in-link/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "SignInLink_inline",
    file: "app/api/admin/team/sign-in-link/route.ts",
    description: "Replace inline check with helper",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Service-role read avoids the RLS race that 403'd legit platform
    // admins on the Vercel edge.
    const adminCli = supabaseAdmin();
    const { data: me } = await adminCli
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }`,
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    // The helper does its own service-role profile read so the RLS-race
    // dodge that this route documented is preserved.
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

console.log(`\n=== F22+F171 Step 2c summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
