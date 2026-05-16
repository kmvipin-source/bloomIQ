// scripts/refactor-f22-step3.mjs
// F22 Step 3 — migrate 5 mutating non-admin routes to requireAuthenticated.
// This is where the actual single-session enforcement risk gets closed:
// every one of these routes now rejects requests whose JWT iat is older
// than the user's current session_iat. No more zombie tokens from a
// previous device.
//
// Routes covered (high-traffic mutating):
//   1. /api/teacher/assign-flashcards/route.ts
//   2. /api/teacher/assign-practice/route.ts
//   3. /api/teacher/coach/route.ts
//   4. /api/checkout/route.ts
//   5. /api/checkout/verify/route.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. teacher/assign-flashcards ───────────────────────────────────────
  {
    tag: "AssignFC_import",
    file: "app/api/teacher/assign-flashcards/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    tag: "AssignFC_block",
    file: "app/api/teacher/assign-flashcards/route.ts",
    description: "Replace inline auth block — F22 iat enforcement now applied",
    find: `    const token = getBearer(req);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — single-session iat
    // enforcement now applied to this mutating route. Old tokens from
    // a previous device are rejected with session_superseded 401.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb, token } = auth;`,
  },

  // ─── 2. teacher/assign-practice ─────────────────────────────────────────
  {
    tag: "AssignPractice_import",
    file: "app/api/teacher/assign-practice/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    tag: "AssignPractice_block",
    file: "app/api/teacher/assign-practice/route.ts",
    description: "Replace inline auth block",
    find: `    const token = getBearer(req);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  },

  // ─── 3. teacher/coach ───────────────────────────────────────────────────
  {
    tag: "Coach_import",
    file: "app/api/teacher/coach/route.ts",
    description: "Add helper import (route currently imports only getBearer+supabaseServer)",
    find: `import { getBearer, supabaseServer } from "@/lib/supabase/server";`,
    replace: `import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    tag: "Coach_block",
    file: "app/api/teacher/coach/route.ts",
    description: "Replace inline auth block",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement now applied to the teacher-coach mutating route.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  },

  // ─── 4. checkout ────────────────────────────────────────────────────────
  {
    tag: "Checkout_import",
    file: "app/api/checkout/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    tag: "Checkout_block",
    file: "app/api/checkout/route.ts",
    description: "Replace inline auth block — critical for payment endpoints",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — payment-creation
    // route now rejects stale tokens from previous devices. Important
    // here specifically: a stolen access token issued before a later
    // sign-in elsewhere can no longer create a Razorpay order on the
    // legitimate user's behalf.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  },

  // ─── 5. checkout/verify ─────────────────────────────────────────────────
  {
    tag: "CheckoutVerify_import",
    file: "app/api/checkout/verify/route.ts",
    description: "Add helper import",
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    tag: "CheckoutVerify_block",
    file: "app/api/checkout/verify/route.ts",
    description: "Replace inline auth block — payment verify must also F22-gate",
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — payment-verify
    // route now also enforces single-session. Pairs with the same
    // gate on /api/checkout (order creation).
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
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

console.log(`\n=== F22 Step 3 summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
