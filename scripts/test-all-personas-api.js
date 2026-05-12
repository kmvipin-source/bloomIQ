// Smoke-tests every API endpoint against every persona.
//
// What it does (per persona):
//   1) Signs in via Supabase auth/v1/token (password grant)
//   2) Calls a curated list of API endpoints with that persona's bearer token
//   3) Records status + key response shape for each call
//
// What it asserts (per call):
//   - Endpoints that SHOULD work for this persona → expect 200/201
//   - Endpoints that SHOULDN'T work → expect 401/402/403
//   - The new Free-tier caps fire correctly (Free → 402 on second/sixth call)
//
// Run from project root with your dev server already running on :3000:
//   node scripts/test-all-personas-api.js
//
// Exit: 0 on all-green, 1 on any FAIL.

const fs = require("fs");
const path = require("path");

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const env = loadEnv();
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP_BASE = process.env.APP_BASE || "http://localhost:3000";
const PASS = process.env.SEED_PASSWORD || "FreshPass123!";

if (!SUPA_URL || !SUPA_ANON) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

// ---------- Personas ----------
const PERSONAS = [
  // independents
  { key: "free",          email: "free.zoya@example.com",        expectTier: "free",          isStudent: true },
  { key: "free2",         email: "free.aarav@example.com",       expectTier: "free",          isStudent: true },
  { key: "premium",       email: "premium.neha@example.com",     expectTier: "premium",       isStudent: true },
  { key: "premium_plus",  email: "pplus.arjun@example.com",      expectTier: "premium_plus",  isStudent: true },
  // school staff
  { key: "admin_head",    email: "head.hema@sunrise.example.com",      expectRole: "super_teacher" },
  { key: "deputy",        email: "vice.vihaan@sunrise.example.com",    expectRole: "super_teacher" },
  { key: "primary_t",     email: "mr.dev@sunrise.example.com",         expectRole: "teacher" },
  { key: "co_t",          email: "ms.tara@sunrise.example.com",        expectRole: "teacher" },
  // school students sign in with synthetic emails (username@bloomiq.invalid)
  { key: "school_stu",    email: "ravi@bloomiq.invalid",               expectRole: "student", isSchoolStudent: true },
  // platform admin
  { key: "platform_admin",email: "vipin.qa@bloomiq.example.com",       expectRole: "platform_admin", expectPlatformAdmin: true },
];

// ---------- Endpoints we test ----------
// Each entry: { name, method, url, body, expectStatusByRole: { role: status[] } }
// "role" key matches PERSONAS[].key. Default expect = 200.
// 402 = quota gate fired (correct behaviour for Free hitting caps)
const TESTS = [
  { name: "auth/me",                  m: "GET",  u: "/api/auth/me" },
  { name: "feature/usage",            m: "GET",  u: "/api/feature/usage", studentsOnly: true },
  { name: "sprint/today",             m: "GET",  u: "/api/sprint/today",  studentsOnly: true },
  { name: "srs/due",                  m: "GET",  u: "/api/srs/due",       studentsOnly: true },
  { name: "student/score",            m: "GET",  u: "/api/student/score", studentsOnly: true },
  { name: "student/digest",           m: "POST", u: "/api/student/digest", body: { window: "weekly" }, studentsOnly: true },
  { name: "student/missed-assignments", m: "GET", u: "/api/student/missed-assignments", studentsOnly: true },
  // School-admin / teacher reads
  { name: "admin/free-tier-limits",   m: "GET",  u: "/api/admin/free-tier-limits", platformAdminOnly: true },
  { name: "admin/plans",              m: "GET",  u: "/api/admin/plans",            platformAdminOnly: true },
  { name: "pricing/active-plans",     m: "GET",  u: "/api/pricing/active-plans" }, // public-ish
];

// ---------- HTTP helpers ----------
async function signIn(email) {
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` },
    body: JSON.stringify({ email, password: PASS }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`sign-in failed (${email}): ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

async function call(method, url, token, body) {
  const r = await fetch(APP_BASE + url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  let j = null;
  if (ct.includes("json")) { try { j = await r.json(); } catch {} }
  return { status: r.status, ok: r.ok, body: j };
}

// ---------- Per-persona runner ----------
const c = (s) => `[${s}m`;
const RESET = c(0), GREEN = c(32), RED = c(31), DIM = c(2), BOLD = c(1), CYAN = c(36), AMBER = c(33);

const results = []; // { persona, test, status, verdict, note }

function record(persona, test, status, verdict, note) {
  results.push({ persona, test, status, verdict, note });
  const colour = verdict === "PASS" ? GREEN : verdict === "EXPECTED" ? CYAN : RED;
  console.log(`  ${colour}${verdict}${RESET}  ${persona.padEnd(15)}  ${test.padEnd(40)}  ${status}${note ? "  " + DIM + note + RESET : ""}`);
}

async function runPersona(p) {
  console.log(`\n${BOLD}=== ${p.key} (${p.email}) ===${RESET}`);
  let token;
  try { token = await signIn(p.email); }
  catch (e) { console.log(`  ${RED}SIGN-IN FAIL${RESET} — ${e.message}`); results.push({ persona: p.key, test: "sign-in", status: "ERR", verdict: "FAIL", note: e.message }); return; }
  record(p.key, "sign-in", "200", "PASS");

  // auth/me + identity assertions
  const me = await call("GET", "/api/auth/me", token);
  if (me.status !== 200) { record(p.key, "auth/me", me.status, "FAIL", "expected 200"); }
  else {
    const okRole = !p.expectRole || me.body.role === p.expectRole;
    const okPA = p.expectPlatformAdmin ? me.body.platform_admin === true : true;
    record(p.key, "auth/me", 200, okRole && okPA ? "PASS" : "FAIL",
      `role=${me.body.role} platform_admin=${me.body.platform_admin} tier=${me.body.tier ?? "n/a"}`);
  }

  // Feature usage (students only). For Free user, also assert tier=free + caps non-null.
  if (p.isStudent) {
    const u = await call("GET", "/api/feature/usage", token);
    if (u.status !== 200) record(p.key, "feature/usage", u.status, "FAIL");
    else {
      const tierOk = u.body.tier === p.expectTier;
      const capsExpected = p.expectTier === "free"
        ? typeof u.body.daily.tutor_chat.cap === "number"
        : u.body.daily.tutor_chat.cap === null;
      record(p.key, "feature/usage", 200, tierOk && capsExpected ? "PASS" : "FAIL",
        `tier=${u.body.tier} tutor.cap=${u.body.daily.tutor_chat.cap}`);
    }
  }

  // Generic reads
  for (const t of TESTS) {
    if (t.name === "feature/usage" || t.name === "auth/me") continue;
    const skipStudentsOnly = t.studentsOnly && !p.isStudent;
    if (skipStudentsOnly) continue;
    const expectsForbidden = (t.platformAdminOnly && !p.expectPlatformAdmin);
    const r = await call(t.m, t.u, token, t.body || null);
    if (expectsForbidden) {
      record(p.key, t.name, r.status, [401, 403].includes(r.status) ? "EXPECTED" : "FAIL",
        [401, 403].includes(r.status) ? "correctly blocked" : "should have been 401/403");
    } else {
      record(p.key, t.name, r.status, r.status === 200 ? "PASS" : "FAIL",
        r.body?.error ? r.body.error.slice(0, 60) : "");
    }
  }

  // Free-tier cap probe: only for the "free" persona. Hit tutor 6x, verify 6th is 402.
  if (p.key === "free") {
    const calls = [];
    for (let i = 1; i <= 6; i++) {
      const r = await call("POST", "/api/tutor/chat", token, { message: `cap probe ${i}: brief reply`, history: [] });
      calls.push(r.status);
    }
    const okPattern = calls.slice(0, 5).every(s => s === 200) && calls[5] === 402;
    record(p.key, "tutor cap (5/day)", calls.join(","), okPattern ? "PASS" : "FAIL",
      okPattern ? "5×200 then 402" : `got [${calls.join(",")}]`);
  }
}

// ---------- Main ----------
(async () => {
  console.log(`${BOLD}Full-persona API smoke test${RESET}`);
  console.log(`Supabase: ${SUPA_URL}`);
  console.log(`App: ${APP_BASE}`);
  console.log(`Personas: ${PERSONAS.length}`);

  for (const p of PERSONAS) {
    await runPersona(p);
  }

  // Summary
  const total = results.length;
  const pass = results.filter(r => r.verdict === "PASS" || r.verdict === "EXPECTED").length;
  const fail = results.filter(r => r.verdict === "FAIL").length;
  console.log(`\n${BOLD}Summary:${RESET}  ${GREEN}${pass} pass${RESET}  ·  ${fail > 0 ? RED : DIM}${fail} fail${RESET}  ·  ${total} total`);
  if (fail > 0) {
    console.log(`\n${RED}Failures:${RESET}`);
    for (const r of results.filter(x => x.verdict === "FAIL")) {
      console.log(`  ${RED}✗${RESET}  ${r.persona}  ${r.test}  status=${r.status}  ${r.note || ""}`);
    }
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("\nFATAL:", e.stack || e.message); process.exit(2); });
