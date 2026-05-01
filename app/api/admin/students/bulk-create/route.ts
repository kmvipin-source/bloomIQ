import { NextResponse } from "next/server";
import {
  getBearer,
  supabaseServer,
  supabaseAdmin,
  usernameToSyntheticEmail,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/i;

type IncomingRow = {
  index: number;
  fullName: string;
  username: string;
  password: string;
  action: "create" | "use_existing" | "skip";
  existingId?: string | null;
  rollNumber?: string | null;
};

type OutcomeRow = {
  index: number;
  fullName: string;
  username: string | null;
  password: string | null;   // returned ONLY for newly created accounts
  status: "created" | "added-existing" | "skipped" | "failed";
  reason?: string;
};

/**
 * POST /api/admin/students/bulk-create
 *
 * Body: { class_id: string, rows: IncomingRow[] }
 *
 * Commits a previously-previewed batch of students. Per-row action:
 *   - "create"        -> new auth user + profile + class_members row
 *   - "use_existing"  -> just add the named existing student to this class
 *   - "skip"          -> no-op, returned in the result for completeness
 *
 * Each row is processed independently. If one fails (e.g. username taken
 * mid-batch), the others still go through. The response includes the
 * generated password for newly-created students so the client can render
 * the credentials sheet.
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
    const rows: IncomingRow[] = Array.isArray(body.rows) ? body.rows : [];
    if (!classId) return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    if (rows.length === 0) return NextResponse.json({ error: "Nothing to create" }, { status: 400 });
    if (rows.length > 200) return NextResponse.json({ error: "Too many rows (max 200)" }, { status: 400 });

    const { data: cls } = await sb
      .from("classes").select("id, owner_id, school_id").eq("id", classId).single();
    if (!cls || cls.owner_id !== user.id) {
      return NextResponse.json({ error: "Class not found or not yours" }, { status: 403 });
    }

    const admin = supabaseAdmin();
    const outcomes: OutcomeRow[] = [];

    // Defensive: prevent the same generated username from being reused twice
    // within the same batch. The single-add path checks via createUser's
    // synthetic email collision; here we cheaply de-dup locally.
    const usernamesSeen = new Set<string>();

    for (const r of rows) {
      const idx = Number(r.index ?? outcomes.length);
      const fullName = String(r.fullName || "").trim();
      const username = String(r.username || "").trim().toLowerCase();
      const password = String(r.password || "");
      const action = r.action;
      const rollNumber: string | null =
        typeof r.rollNumber === "string" && r.rollNumber.trim().length > 0
          ? r.rollNumber.trim()
          : null;

      if (action === "skip") {
        outcomes.push({ index: idx, fullName, username: null, password: null, status: "skipped", reason: "Skipped by teacher" });
        continue;
      }

      if (action === "use_existing") {
        const existingId = String(r.existingId || "").trim();
        if (!existingId) {
          outcomes.push({ index: idx, fullName, username: null, password: null, status: "failed", reason: "use_existing without existingId" });
          continue;
        }
        const { error: memErr } = await admin
          .from("class_members")
          .upsert(
            { class_id: classId, student_id: existingId, roll_number: rollNumber },
            { onConflict: "class_id,student_id" }
          );
        if (memErr) {
          outcomes.push({ index: idx, fullName, username: null, password: null, status: "failed", reason: memErr.message });
        } else {
          outcomes.push({ index: idx, fullName, username: null, password: null, status: "added-existing" });
        }
        continue;
      }

      // action === "create"
      if (!fullName) {
        outcomes.push({ index: idx, fullName, username: null, password: null, status: "failed", reason: "Name is empty" });
        continue;
      }
      if (!USERNAME_RE.test(username)) {
        outcomes.push({ index: idx, fullName, username, password: null, status: "failed", reason: "Username must be 3-30 chars, letters/numbers/dot/dash/underscore" });
        continue;
      }
      if (password.length < 6) {
        outcomes.push({ index: idx, fullName, username, password: null, status: "failed", reason: "Password must be at least 6 chars" });
        continue;
      }
      if (usernamesSeen.has(username)) {
        outcomes.push({ index: idx, fullName, username, password: null, status: "failed", reason: "Duplicate username in this batch" });
        continue;
      }
      usernamesSeen.add(username);

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
      if (createErr || !created.user?.id) {
        const msg = createErr?.message?.toLowerCase().includes("registered")
          ? "That username is already taken"
          : (createErr?.message || "createUser failed");
        outcomes.push({ index: idx, fullName, username, password: null, status: "failed", reason: msg });
        continue;
      }
      const newId = created.user.id;

      // Defensive profile upsert + school_id propagation, mirroring single-add.
      await admin.from("profiles").upsert({
        id: newId,
        role: "student",
        full_name: fullName,
        username,
        is_school_student: true,
        school_id: cls.school_id || null,
      }, { onConflict: "id" });

      const { error: memErr } = await admin
        .from("class_members")
        .insert({ class_id: classId, student_id: newId, roll_number: rollNumber });
      if (memErr && !memErr.message.toLowerCase().includes("duplicate")) {
        // Roll back the auth user so we don't leave an orphan.
        await admin.auth.admin.deleteUser(newId).catch(() => {});
        outcomes.push({ index: idx, fullName, username, password: null, status: "failed", reason: memErr.message });
        continue;
      }

      outcomes.push({ index: idx, fullName, username, password, status: "created" });
    }

    const summary = {
      created: outcomes.filter((o) => o.status === "created").length,
      addedExisting: outcomes.filter((o) => o.status === "added-existing").length,
      skipped: outcomes.filter((o) => o.status === "skipped").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
    };

    return NextResponse.json({ ok: true, outcomes, summary });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Bulk create failed" },
      { status: 500 }
    );
  }
}
