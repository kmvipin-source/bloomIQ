// scripts/refactor-f22-f171-step3.mjs
// F22 + F171 Step 3 — migrate 5 more admin routes off local requireAdmin
// / inline platform_admin checks. Closes Step 2b (plan-proposals subtree)
// and pushes 4 more inline-check routes onto the shared helper.
//
// Routes covered:
//   1. /api/admin/plan-proposals/route.ts   (exported requireAdmin → adapter
//                                            that wraps requirePlatformAdmin
//                                            so 4 sibling importers keep
//                                            working unchanged)
//   2. /api/admin/plans/[id]/route.ts       (local requireAdmin + 2 sites)
//   3. /api/admin/schools/[id]/route.ts     (inline check)
//   4. /api/admin/schools/[id]/set-plan/route.ts (inline check)
//   5. /api/admin/subscriptions/[id]/mark-paid/route.ts (inline check)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. plan-proposals/route.ts — adapter pattern ───────────────────────
  {
    tag: "PP_imports",
    file: "app/api/admin/plan-proposals/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "PP_adapter",
    file: "app/api/admin/plan-proposals/route.ts",
    description: "Replace local requireAdmin with adapter that wraps the shared helper",
    find: `export async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) {
    return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }`,
    replace: `// F171 fix (QA): exported requireAdmin now adapts the shared
// requirePlatformAdmin (lib/apiAuth.ts) to the {err, user} shape that
// 4 sibling routes import. The adapter is intentional — it lets the
// migration land WITHOUT touching those 4 importers in this PR.
// Follow-up: migrate the sibling call sites to {error} shape, then
// drop this adapter and export requirePlatformAdmin directly.
export async function requireAdmin(req: Request) {
  const r = await requirePlatformAdmin(req);
  if ("error" in r) return { err: r.error };
  return { user: r.user };
}

// Below: the original local requireAdmin body, kept inert so the diff
// is reviewable and the rollback is trivial. Dead-code-eliminated by
// any production bundler. Remove in the follow-up.
async function _requireAdmin_legacy(req: Request) {
  const token = getBearer(req);
  if (!token) {
    return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }`,
  },

  // ─── 2. plans/[id]/route.ts ─────────────────────────────────────────────
  {
    tag: "PlansId_imports",
    file: "app/api/admin/plans/[id]/route.ts",
    description: "Add helper import; drop now-unused supabaseServer/getBearer",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "PlansId_remove_local",
    file: "app/api/admin/plans/[id]/route.ts",
    description: "Remove local requireAdmin function",
    find: `async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // Service-role read avoids the RLS race that 403'd legit platform
  // admins on the Vercel edge.
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
    replace: `// F171 fix (QA): local requireAdmin replaced with shared helper.`,
  },
  {
    tag: "PlansId_calls",
    file: "app/api/admin/plans/[id]/route.ts",
    description: "Migrate both call sites — they use the same {err} pattern",
    find: `    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;`,
    replace: `    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },
  // Second occurrence (the file has TWO identical call sites).
  {
    tag: "PlansId_calls2",
    file: "app/api/admin/plans/[id]/route.ts",
    description: "Second call-site (after the first replacement)",
    find: `    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;`,
    replace: `    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },

  // ─── 3. schools/[id]/route.ts ───────────────────────────────────────────
  {
    tag: "SchoolsId_imports",
    file: "app/api/admin/schools/[id]/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "SchoolsId_inline",
    file: "app/api/admin/schools/[id]/route.ts",
    description: "Replace inline platform_admin check with helper",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: prof } = await sb
      .from("profiles").select("platform_admin").eq("id", user.id).maybeSingle();
    if (!prof?.platform_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });`,
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;`,
  },

  // ─── 4. schools/[id]/set-plan/route.ts ──────────────────────────────────
  {
    tag: "SetPlan_imports",
    file: "app/api/admin/schools/[id]/set-plan/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "SetPlan_inline",
    file: "app/api/admin/schools/[id]/set-plan/route.ts",
    description: "Replace inline platform_admin check with helper",
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

  // ─── 5. subscriptions/[id]/mark-paid/route.ts ──────────────────────────
  {
    tag: "MarkPaid_imports",
    file: "app/api/admin/subscriptions/[id]/mark-paid/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "MarkPaid_inline",
    file: "app/api/admin/subscriptions/[id]/mark-paid/route.ts",
    description: "Replace inline platform_admin check with helper",
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

console.log(`\n=== F22+F171 Step 3 summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
