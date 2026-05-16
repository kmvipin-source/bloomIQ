import { NextResponse } from "next/server";
import {
  supabaseAdmin,
  usernameToSyntheticEmail,
} from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/i;
const ROLL_RE = /^[A-Za-z0-9]+$/;

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
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return m[a.length][b.length];
}

/**
 * Fuzzy match gated on length >= 4 on BOTH sides.
 * Stops "S1" vs "S3" false positives where edit distance equals tolerance.
 */
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

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json();
    const classId: string = String(body.class_id || "").trim();
    const fullName: string = String(body.full_name || "").trim();
    const username: string = String(body.username || "").trim().toLowerCase();
    const password: string = String(body.password || "");
    const force: boolean = !!body.force;
    // Optional per-class roll number. Trimmed; empty becomes null.
    const rollNumberRaw = body.roll_number;
    const rollNumber: string | null =
      typeof rollNumberRaw === "string" && rollNumberRaw.trim().length > 0
        ? rollNumberRaw.trim()
        : (typeof rollNumberRaw === "number" ? String(rollNumberRaw) : null);

    if (!classId) return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    if (!fullName) return NextResponse.json({ error: "Student name is required" }, { status: 400 });
    if (!USERNAME_RE.test(username)) {
      return NextResponse.json({
        error: "Username must be 3-30 chars, letters/numbers/dot/dash/underscore, starting with a letter or number.",
      }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }
    if (rollNumber !== null && !ROLL_RE.test(rollNumber)) {
      return NextResponse.json({ error: "Roll number must be alphanumeric (letters and digits only)." }, { status: 400 });
    }

    const { data: cls } = await sb.from("classes").select("id, owner_id").eq("id", classId).single();
    if (!cls || cls.owner_id !== user.id) {
      return NextResponse.json({ error: "Class not found or not yours" }, { status: 403 });
    }

    const admin = supabaseAdmin();

    if (!force) {
      const { data: meProf } = await admin
        .from("profiles")
        .select("school_id")
        .eq("id", user.id)
        .maybeSingle();
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
        .from("class_teachers")
        .select("class_id")
        .eq("teacher_id", user.id);
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

      // Filter out ORPHAN candidates (zero class memberships). These are
      // stale accounts left over from previous "Remove" operations - they
      // have a profile row but aren't actively in any class. Treating them
      // as duplicate candidates produces false positives like the "S1 was
      // removed but new S1 still triggers a dup warning" report.
      // Note: the auth account is preserved on remove, but the duplicate
      // surface only cares about students currently active in some class.
      if (candidates.length > 0) {
        const ids = candidates.map((c) => c.id);
        const { data: liveMems } = await admin
          .from("class_members")
          .select("student_id")
          .in("student_id", ids);
        const live = new Set(((liveMems as { student_id: string }[]) || []).map((m) => m.student_id));
        candidates = candidates.filter((c) => live.has(c.id));
      }

      const matches = candidates.filter((c) => c.full_name && looksLikeMatch(fullName, c.full_name));

      if (matches.length > 0) {
        const myCtSet = new Set(myClassIds);
        const myOwnClassesSet = new Set<string>();
        const { data: ownedRows } = await admin.from("classes").select("id").eq("owner_id", user.id);
        ((ownedRows as Array<{ id: string }> | null) || []).forEach((c) => myOwnClassesSet.add(c.id));

        const enriched = await Promise.all(
          matches.map(async (m) => {
            const { data: cm } = await admin
              .from("class_members")
              .select("class:classes(id, name, grade, section)")
              .eq("student_id", m.id);
            type Row = { class: { id: string; name: string; grade: string | null; section: string | null } | null };
            const classes = ((cm as unknown as Row[]) || [])
              .map((r) => r.class)
              .filter((c): c is { id: string; name: string; grade: string | null; section: string | null } => !!c);

            let confidence: "certain" | "high" | "medium" | "low" = "low";
            if (classes.some((c) => c.id === classId)) confidence = "certain";
            else if (classes.some((c) => myOwnClassesSet.has(c.id))) confidence = "high";
            else if (classes.some((c) => myCtSet.has(c.id))) confidence = "medium";

            return { ...m, classes, confidence };
          })
        );
        return NextResponse.json({
          error: "duplicate_name",
          message: `Found ${matches.length} possible duplicate${matches.length === 1 ? "" : "s"}.`,
          matches: enriched,
        }, { status: 409 });
      }
    }

    const email = usernameToSyntheticEmail(username);
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: "student",
        full_name: fullName,
        username,
        is_school_student: true,
      },
    });
    if (createErr) {
      const msg = createErr.message?.toLowerCase().includes("registered")
        ? "That username is already taken."
        : createErr.message;
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    const newId = created.user?.id;
    if (!newId) return NextResponse.json({ error: "Could not create student" }, { status: 500 });

    const { data: meProf2 } = await admin.from("profiles").select("school_id").eq("id", user.id).maybeSingle();
    await admin.from("profiles").upsert({
      id: newId,
      role: "student",
      full_name: fullName,
      username,
      is_school_student: true,
      school_id: meProf2?.school_id || null,
    }, { onConflict: "id" });

    const { error: memErr } = await admin.from("class_members").insert({
      class_id: classId,
      student_id: newId,
      roll_number: rollNumber,
    });
    if (memErr && !memErr.message.toLowerCase().includes("duplicate")) {
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      return NextResponse.json({ error: memErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      student: { id: newId, full_name: fullName, username },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create student" }, { status: 500 });
  }
}
