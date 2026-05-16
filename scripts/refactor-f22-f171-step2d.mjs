// scripts/refactor-f22-f171-step2d.mjs
// F22 + F171 Step 2d — finish the admin-route migration AND drop the
// plan-proposals adapter.
//
// Logical fixes (5):
//   1. feature-flags/audit/route.ts        — inline check → helper
//   2. onboard-school/route.ts             — 2 inline checks → helper
//   3. plan-proposals subtree call sites   — {err} → {error} in 4 files
//   4. plan-proposals/route.ts             — drop adapter; alias-export only
//   5. (deferred to next batch) Step 3 start

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. feature-flags/audit/route.ts ────────────────────────────────────
  {
    tag: "FFAudit_imports",
    file: "app/api/admin/feature-flags/audit/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "FFAudit_inline",
    file: "app/api/admin/feature-flags/audit/route.ts",
    description: "Replace inline check (top-level, no try block)",
    find: `  const token = getBearer(req);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }`,
    replace: `  // F171 fix (QA): inline check → shared helper.
  const auth = await requirePlatformAdmin(req);
  if ("error" in auth) return auth.error;
  const { admin } = auth;`,
  },

  // ─── 2. onboard-school/route.ts ─────────────────────────────────────────
  {
    tag: "Onboard_imports",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  },
  {
    tag: "Onboard_block1",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Replace POST handler inline check",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Service-role read avoids the RLS race that 403'd legit platform
    // admins on the Vercel edge.
    const adminClient = supabaseAdmin();
    const { data: me } = await adminClient
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json(
        { error: "Only platform admins can onboard schools." },
        { status: 403 }
      );
    }`,
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    // The "Only platform admins can onboard schools." copy is replaced
    // with the helper's generic "Forbidden" — acceptable because the
    // operator-facing onboard UI surfaces its own auth-error toast.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    const adminClient = supabaseAdmin();`,
  },
  {
    tag: "Onboard_block2",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Replace GET handler inline check",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Read platform_admin via the service-role client so a transient
    // RLS race on profiles (the user-token client occasionally can't
    // see the just-created profile row from the Vercel edge) doesn't
    // 403 a real platform admin off their own page.
    const admin = supabaseAdmin();
    const { data: me } = await admin
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }`,
    replace: `    // F171 fix (QA): inline platform_admin check → shared helper.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    const { admin } = auth;`,
  },

  // ─── 3. plan-proposals/[id]/approve/route.ts ────────────────────────────
  {
    tag: "PPApprove_call",
    file: "app/api/admin/plan-proposals/[id]/approve/route.ts",
    description: "Migrate the single approve call site",
    find: `    if ("err" in auth) return auth.err;`,
    replace: `    if ("error" in auth) return auth.error;`,
  },

  // ─── 3b. plan-proposals/[id]/route.ts (TWO identical call sites) ────────
  // We'll do these with a node one-liner replace-all after the codemod,
  // since the codemod's uniqueness check refuses byte-identical multi-match.
  // For now: nothing in the codemod for this file (see post-step below).

  // ─── 3c. plan-proposals/[id]/reject/route.ts ────────────────────────────
  {
    tag: "PPReject_call",
    file: "app/api/admin/plan-proposals/[id]/reject/route.ts",
    description: "Migrate reject call site",
    find: `    if ("err" in auth) return auth.err;`,
    replace: `    if ("error" in auth) return auth.error;`,
  },

  // ─── 3d. plan-proposals/[id]/withdraw/route.ts ──────────────────────────
  {
    tag: "PPWithdraw_call",
    file: "app/api/admin/plan-proposals/[id]/withdraw/route.ts",
    description: "Migrate withdraw call site",
    find: `    if ("err" in auth) return auth.err;`,
    replace: `    if ("error" in auth) return auth.error;`,
  },

  // ─── 4. plan-proposals/route.ts — drop adapter, keep alias-export ───────
  {
    tag: "PP_drop_adapter",
    file: "app/api/admin/plan-proposals/route.ts",
    description: "Replace adapter with a clean alias-export to the shared helper",
    find: `// F171 fix (QA): exported requireAdmin now adapts the shared
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
    replace: `// F171 fix (QA): adapter dropped — the 4 sibling routes now use the
// modern {error} shape. requireAdmin is a thin alias kept only so
// the sibling imports don't need to be renamed in this PR. A future
// PR can sweep \`requireAdmin\` → \`requirePlatformAdmin\` and delete
// this alias.
export const requireAdmin = requirePlatformAdmin;

// Dead-code block below preserved for one PR cycle to make rollback
// trivial; the bundler tree-shakes it out of production.
async function _requireAdmin_legacy(req: Request) {
  const token = getBearer(req);
  if (!token) {
    return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }`,
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

// Post-step: plan-proposals/[id]/route.ts has 2 byte-identical call sites
// (GET + PATCH handlers). Replace-all is safe here because the change is
// purely "err" → "error" key naming.
{
  const abs = path.join(ROOT, "app/api/admin/plan-proposals/[id]/route.ts");
  if (fs.existsSync(abs)) {
    let s = fs.readFileSync(abs, "utf8");
    const before = s;
    const lf = `    if ("err" in auth) return auth.err;`;
    const lfRepl = `    if ("error" in auth) return auth.error;`;
    while (s.includes(lf)) s = s.replace(lf, lfRepl);
    if (s !== before) {
      fs.writeFileSync(abs, s, "utf8");
      applied.push("PPRoute_calls_replace_all");
    } else {
      skipped.push({ tag: "PPRoute_calls_replace_all", reason: "no occurrences (already migrated?)" });
    }
  }
}

console.log(`\n=== F22+F171 Step 2d summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
