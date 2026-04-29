/**
 * Seed script — creates the test users, schools, classes, and class
 * memberships used across every e2e test. Idempotent: if a user already
 * exists, we reuse it (and update its profile).
 *
 * Called from playwright.config.ts via global-setup.ts. Tests assume seeded
 * data; never write tests that expect a clean DB.
 */

import { admin } from "./supabase-admin";
import {
  FIXTURES,
  TEST_CLASS_A1,
  TEST_CLASS_A2,
  TEST_CLASS_B1,
  usernameToEmail,
} from "./fixtures";

type SeedResult = {
  userIds: Record<string, string>;
  schoolIds: Record<"A" | "B", string>;
  classIds: Record<string, string>;
};

async function ensureAuthUser(
  email: string,
  password: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const sb = admin();
  // Try createUser first; if it fails because the user already exists, look up by email.
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
  });
  if (!error && data?.user) return data.user.id;

  // Already exists — find the id.
  let page = 1;
  for (let i = 0; i < 50; i++) {
    const { data: list, error: listErr } = await sb.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (listErr) throw listErr;
    if (!list || !list.users || list.users.length === 0) break;
    const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) {
      // Reset the password AND mark email as confirmed. The previous seed run
      // may have errored out before profiles/etc. and left an unconfirmed
      // user; updating just the password isn't enough if the project
      // requires email confirmation.
      const updates: { password: string; email_confirm?: boolean } = { password };
      if (!found.email_confirmed_at) updates.email_confirm = true;
      await sb.auth.admin.updateUserById(found.id, updates);
      return found.id;
    }
    if (list.users.length < 200) break;
    page++;
  }
  throw new Error(`Could not find or create auth user for ${email}`);
}

async function upsertProfile(row: Record<string, unknown>) {
  const sb = admin();
  const { error } = await sb.from("profiles").upsert(row, { onConflict: "id" });
  if (error) throw new Error(`profile upsert failed for ${row.id}: ${error.message}`);
}

async function ensureSchool(name: string, superTeacherId: string): Promise<string> {
  const sb = admin();
  const { data: existing, error: selErr } = await sb
    .from("schools")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing?.id) {
    await sb.from("schools").update({ super_teacher_id: superTeacherId }).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await sb
    .from("schools")
    .insert({ name, super_teacher_id: superTeacherId, join_code: `TEST-${name.toUpperCase()}` })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function ensureClass(opts: {
  name: string;
  schoolId: string;
  ownerId: string | null;
  joinCode: string;
}): Promise<string> {
  const sb = admin();
  const { data: existing } = await sb
    .from("classes")
    .select("id")
    .eq("name", opts.name)
    .eq("school_id", opts.schoolId)
    .maybeSingle();
  if (existing?.id) {
    await sb.from("classes").update({ owner_id: opts.ownerId }).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await sb
    .from("classes")
    .insert({
      name: opts.name,
      school_id: opts.schoolId,
      owner_id: opts.ownerId,
      join_code: opts.joinCode,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function ensureClassTeacher(classId: string, teacherId: string, isPrimary: boolean) {
  const sb = admin();
  const { data: existing } = await sb
    .from("class_teachers")
    .select("class_id, role")
    .eq("class_id", classId)
    .eq("teacher_id", teacherId)
    .maybeSingle();
  const desiredRole = isPrimary ? "primary" : "co";
  if (existing) {
    if (existing.role !== desiredRole) {
      const { error } = await sb
        .from("class_teachers")
        .update({ role: desiredRole })
        .eq("class_id", classId)
        .eq("teacher_id", teacherId);
      if (error) throw error;
    }
    return;
  }
  // Schema (migration 04): class_teachers has columns class_id, teacher_id,
  // role text check (role in ('primary','co')), subject, added_at.
  const { error } = await sb.from("class_teachers").insert({
    class_id: classId,
    teacher_id: teacherId,
    role: desiredRole,
  });
  if (error && !error.message.includes("duplicate")) throw error;
}

async function ensureClassMember(classId: string, studentId: string) {
  const sb = admin();
  const { data: existing } = await sb
    .from("class_members")
    .select("class_id")
    .eq("class_id", classId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (existing) return;
  const { error } = await sb
    .from("class_members")
    .insert({ class_id: classId, student_id: studentId });
  if (error && !error.message.includes("duplicate")) throw error;
}

export async function seed(): Promise<SeedResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[seed] env vars missing. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  console.log("[seed] starting...");

  const userIds: Record<string, string> = {};

  for (const key of ["superTeacherA", "superTeacherB"] as const) {
    const f = FIXTURES[key];
    const id = await ensureAuthUser(f.email, f.password, { role: f.role, full_name: f.fullName });
    userIds[key] = id;
    await upsertProfile({ id, role: f.role, full_name: f.fullName });
  }

  for (const key of ["teacherA", "teacherA2", "teacherB"] as const) {
    const f = FIXTURES[key];
    const id = await ensureAuthUser(f.email, f.password, { role: f.role, full_name: f.fullName });
    userIds[key] = id;
    await upsertProfile({ id, role: f.role, full_name: f.fullName });
  }

  for (const key of ["studentA1", "studentA2", "studentB1"] as const) {
    const f = FIXTURES[key];
    const email = usernameToEmail(f.username);
    const id = await ensureAuthUser(email, f.password, {
      role: f.role,
      full_name: f.fullName,
      username: f.username,
    });
    userIds[key] = id;
    await upsertProfile({
      id,
      role: f.role,
      full_name: f.fullName,
      username: f.username,
      is_school_student: true,
    });
  }

  {
    const f = FIXTURES.independentStudent;
    const id = await ensureAuthUser(f.email, f.password, {
      role: f.role,
      full_name: f.fullName,
    });
    userIds["independentStudent"] = id;
    await upsertProfile({
      id,
      role: f.role,
      full_name: f.fullName,
      is_school_student: false,
    });
  }

  // Schools
  const schoolIdA = await ensureSchool(FIXTURES.superTeacherA.schoolName, userIds.superTeacherA);
  const schoolIdB = await ensureSchool(FIXTURES.superTeacherB.schoolName, userIds.superTeacherB);

  // Patch profiles with school_id
  const sb = admin();
  await sb.from("profiles").update({ school_id: schoolIdA }).eq("id", userIds.superTeacherA);
  await sb.from("profiles").update({ school_id: schoolIdB }).eq("id", userIds.superTeacherB);
  await sb.from("profiles").update({ school_id: schoolIdA }).eq("id", userIds.teacherA);
  await sb.from("profiles").update({ school_id: schoolIdA }).eq("id", userIds.teacherA2);
  await sb.from("profiles").update({ school_id: schoolIdB }).eq("id", userIds.teacherB);
  await sb.from("profiles").update({ school_id: schoolIdA }).eq("id", userIds.studentA1);
  await sb.from("profiles").update({ school_id: schoolIdA }).eq("id", userIds.studentA2);
  await sb.from("profiles").update({ school_id: schoolIdB }).eq("id", userIds.studentB1);

  // Classes
  const classA1 = await ensureClass({
    name: TEST_CLASS_A1,
    schoolId: schoolIdA,
    ownerId: userIds.teacherA,
    joinCode: "TESTA1",
  });
  const classA2 = await ensureClass({
    name: TEST_CLASS_A2,
    schoolId: schoolIdA,
    ownerId: userIds.teacherA2,
    joinCode: "TESTA2",
  });
  const classB1 = await ensureClass({
    name: TEST_CLASS_B1,
    schoolId: schoolIdB,
    ownerId: userIds.teacherB,
    joinCode: "TESTB1",
  });

  // class_teachers:
  // teacherA  → primary on A1
  // teacherA2 → co-teacher on A1, primary on A2
  // teacherB  → primary on B1
  await ensureClassTeacher(classA1, userIds.teacherA, true);
  await ensureClassTeacher(classA1, userIds.teacherA2, false);
  await ensureClassTeacher(classA2, userIds.teacherA2, true);
  await ensureClassTeacher(classB1, userIds.teacherB, true);

  // class_members
  await ensureClassMember(classA1, userIds.studentA1);
  await ensureClassMember(classA1, userIds.studentA2);
  await ensureClassMember(classB1, userIds.studentB1);

  console.log(`[seed] done. users=${Object.keys(userIds).length}, schools=2, classes=3`);

  return {
    userIds,
    schoolIds: { A: schoolIdA, B: schoolIdB },
    classIds: { [TEST_CLASS_A1]: classA1, [TEST_CLASS_A2]: classA2, [TEST_CLASS_B1]: classB1 },
  };
}

// To run seeding directly, use `npm run test:e2e:seed` which calls the
// standalone wrapper run-seed.ts. Normally seed() is invoked from
// global-setup.ts before every Playwright test session.
