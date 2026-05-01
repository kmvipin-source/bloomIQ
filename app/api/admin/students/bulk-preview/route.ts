import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/i;

// Confusion-free alphabets for generated usernames + passwords. We drop
// look-alike characters (0/O, 1/l/I) so handwritten credential slips don't
// get mistyped by students.
const USERNAME_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
const PASSWORD_CHARS = "abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function rand(chars: string, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function suggestUsername(): string { return "student." + rand(USERNAME_CHARS, 5); }
function suggestPassword(): string { return rand(PASSWORD_CHARS, 8); }

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}
// Same gating as single-add looksLikeMatch (length >= 4 on both sides).
function looksLikeMatch(candidate: string, existing: string): boolean {
  const a = normaliseName(candidate);
  const b = normaliseName(existing);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const tolerance = Math.max(1, Math.floor(Math.max(a.length, b.length) / 5));
  return editDistance(a, b) <= tolerance;
}

type PreviewMatch = {
  id: string;
  full_name: string | null;
  username: string | null;
  inThisClass: boolean;
};
type PreviewRow = {
  index: number;
  raw: string;
  fullName: string;
  rollNumber: string | null;
  status: "ready" | "duplicate" | "duplicate-in-this-class" | "duplicate-in-paste" | "invalid";
  reason?: string;
  suggestedUsername: string;
  suggestedPassword: string;
  matches: PreviewMatch[];
};

/**
 * Split a paste line into { name, roll }. Accepts:
 *   - "Priya Sharma"            → { name: "Priya Sharma", roll: null }
 *   - "Priya Sharma, 12"        → { name: "Priya Sharma", roll: "12" }
 *   - "Priya Sharma\t12"        → ditto
 *   - "Priya Sharma | 12"       → ditto
 * The first separator (tab, comma, or pipe) wins so names with spaces are fine.
 */
function parseLine(raw: string): { name: string; roll: string | null } {
  const s = String(raw || "").trim();
  if (!s) return { name: "", roll: null };
  const m = s.match(/^([^\t,|]+)[\t,|](.*)$/);
  if (!m) return { name: s.replace(/\s+/g, " "), roll: null };
  const name = m[1].trim().replace(/\s+/g, " ");
  const roll = m[2].trim();
  return { name, roll: roll.length > 0 ? roll : null };
}

const ROLL_RE = /^[A-Za-z0-9]+$/;

/**
 * POST /api/admin/students/bulk-preview
 *
 * Body: { class_id: string, names: string[] }
 *
 * For each name, returns a preview row showing:
 *  - status (ready / duplicate / invalid / dup within the paste itself)
 *  - matched existing students (if any) with whether they're already in
 *    this class (so the UI can offer "use existing" vs "create new anyway")
 *  - a suggested username + password the teacher can edit before committing
 *
 * The teacher then sends the (possibly edited) rows to /bulk-create. This
 * two-step flow mirrors the single-add UX but processes a whole class at
 * once.
 *
 * Auth: caller must own the class (primary teacher).
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const classId: string = String(body.class_id || "").trim();
    const namesRaw: unknown[] = Array.isArray(body.names) ? body.names : [];
    if (!classId) return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    if (namesRaw.length === 0) return NextResponse.json({ error: "Paste at least one name" }, { status: 400 });
    if (namesRaw.length > 200) return NextResponse.json({ error: "Too many names (max 200 at a time)" }, { status: 400 });

    const { data: cls } = await sb.from("classes").select("id, owner_id").eq("id", classId).single();
    if (!cls || cls.owner_id !== user.id) {
      return NextResponse.json({ error: "Class not found or not yours" }, { status: 403 });
    }

    const admin = supabaseAdmin();

    // Pull candidate students once: school students in the same school +
    // students in any class this teacher teaches.
    const { data: meProf } = await admin
      .from("profiles").select("school_id").eq("id", user.id).maybeSingle();
    const schoolId = meProf?.school_id || null;

    let candidates: Array<{ id: string; full_name: string | null; username: string | null }> = [];
    if (schoolId) {
      const { data } = await admin
        .from("profiles")
        .select("id, full_name, username")
        .eq("role", "student")
        .eq("is_school_student", true)
        .eq("school_id", schoolId);
      candidates = (data as typeof candidates) || [];
    }
    const { data: myCt } = await admin
      .from("class_teachers").select("class_id").eq("teacher_id", user.id);
    const myClassIds = (myCt as Array<{ class_id: string }> | null)?.map((c) => c.class_id) || [];
    if (myClassIds.length > 0) {
      const { data: members } = await admin
        .from("class_members")
        .select("student_id, profile:profiles!class_members_student_id_fkey(id, full_name, username, is_school_student)")
        .in("class_id", myClassIds);
      type Mem = { student_id: string; profile: { id: string; full_name: string | null; username: string | null; is_school_student: boolean } | null };
      ((members as unknown as Mem[]) || []).forEach((m) => {
        if (m.profile && m.profile.is_school_student && !candidates.some((c) => c.id === m.profile!.id)) {
          candidates.push({ id: m.profile.id, full_name: m.profile.full_name, username: m.profile.username });
        }
      });
    }

    // Drop orphans (zero class memberships) - they're stale accounts and
    // would generate false-positive duplicate flags.
    if (candidates.length > 0) {
      const ids = candidates.map((c) => c.id);
      const { data: liveMems } = await admin
        .from("class_members").select("student_id").in("student_id", ids);
      const live = new Set(((liveMems as { student_id: string }[]) || []).map((m) => m.student_id));
      candidates = candidates.filter((c) => live.has(c.id));
    }

    // Look up which candidates are already in THIS class so we can label
    // them differently in the preview ("already enrolled here, skipping
    // unless you re-add").
    const inThisClass = new Set<string>();
    if (candidates.length > 0) {
      const { data: rosterRows } = await admin
        .from("class_members").select("student_id").eq("class_id", classId);
      ((rosterRows as { student_id: string }[] | null) || []).forEach((r) => inThisClass.add(r.student_id));
    }

    // Pre-collect existing usernames so the suggested usernames don't
    // collide. We retry up to a few times if the random pick happens to
    // clash with what's already taken.
    const takenUsernames = new Set<string>(
      candidates.map((c) => (c.username || "").toLowerCase()).filter(Boolean)
    );

    const seenInPaste = new Map<string, number>(); // normalised name -> first index

    const rows: PreviewRow[] = namesRaw.map((raw, i) => {
      const parsed = parseLine(String(raw ?? ""));
      const fullName = parsed.name;
      const rollNumber = parsed.roll;
      let username = suggestUsername();
      for (let attempt = 0; attempt < 5 && takenUsernames.has(username); attempt++) {
        username = suggestUsername();
      }
      takenUsernames.add(username);
      const password = suggestPassword();

      if (!fullName) {
        return { index: i, raw: String(raw ?? ""), fullName: "", rollNumber, status: "invalid", reason: "Empty line", suggestedUsername: username, suggestedPassword: password, matches: [] };
      }
      if (rollNumber !== null && !ROLL_RE.test(rollNumber)) {
        return { index: i, raw: String(raw), fullName, rollNumber, status: "invalid", reason: `Roll "${rollNumber}" must be alphanumeric`, suggestedUsername: username, suggestedPassword: password, matches: [] };
      }

      // Check for dup within the paste itself (case-insensitive normalised).
      const norm = normaliseName(fullName);
      if (norm && seenInPaste.has(norm)) {
        return {
          index: i,
          raw: String(raw),
          fullName,
          rollNumber,
          status: "duplicate-in-paste",
          reason: `Same as line ${seenInPaste.get(norm)! + 1}`,
          suggestedUsername: username,
          suggestedPassword: password,
          matches: [],
        };
      }
      if (norm) seenInPaste.set(norm, i);

      const matches = candidates
        .filter((c) => c.full_name && looksLikeMatch(fullName, c.full_name))
        .map<PreviewMatch>((c) => ({
          id: c.id,
          full_name: c.full_name,
          username: c.username,
          inThisClass: inThisClass.has(c.id),
        }));

      if (matches.length === 0) {
        return { index: i, raw: String(raw), fullName, rollNumber, status: "ready", suggestedUsername: username, suggestedPassword: password, matches: [] };
      }
      const alreadyHere = matches.some((m) => m.inThisClass);
      return {
        index: i,
        raw: String(raw),
        fullName,
        rollNumber,
        status: alreadyHere ? "duplicate-in-this-class" : "duplicate",
        suggestedUsername: username,
        suggestedPassword: password,
        matches,
      };
    });

    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Bulk preview failed" },
      { status: 500 }
    );
  }
}
