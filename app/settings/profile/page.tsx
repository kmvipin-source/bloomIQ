"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import {
  User as UserIcon, Mail, Building2, GraduationCap, Users,
  ShieldCheck, KeyRound, Palette, Copy, Check, Save, ArrowRight, ArrowLeft, Image as ImageIcon, Trash2,
} from "lucide-react";
import type { LearnerProfile } from "@/components/LearnerProfilePrompt";
import CurrentPlanBadge from "@/components/CurrentPlanBadge";
import { STUDENT_GOALS } from "@/components/StudentGoalPicker";

/**
 * /settings/profile — unified profile page, role-aware.
 *
 * One page, sections shown / hidden by role:
 *   - Independent student: name (editable), exam goal (editable),
 *     avatar, email (RO), password change, 2FA link, theme link.
 *   - School student: name (RO — admin-managed), class memberships,
 *     avatar, password change.
 *   - Teacher: name (editable), school they're in (RO), classes
 *     they teach (RO list), contact email (RO), password, 2FA.
 *   - Super-teacher (school admin): school identity (RO), school
 *     join code (with copy), plan badge, password, 2FA.
 *   - Platform admin: link out to /admin/security.
 *
 * Naming, password, and 2FA are universal — every role sees password
 * (link to /auth/set-password) and 2FA (link to /settings/security)
 * EXCEPT school students whose teacher manages their credentials.
 */

type Role = "student" | "teacher" | "super_teacher";
type Profile = {
  id: string;
  role: Role;
  full_name: string | null;
  is_school_student: boolean | null;
  exam_goal: string | null;
  learner_profile: LearnerProfile | null;
  school_id: string | null;
  platform_admin: boolean | null;
};
type ClassMembership = { id: string; name: string };
type SchoolInfo = { id: string; name: string; join_code: string | null; logo_url: string | null };

function initialOf(name: string, email: string): string {
  const src = (name || email || "?").trim();
  if (!src) return "?";
  // First salutation-stripped token's first char.
  const t = src.split(/\s+/).find((x) => !/^(mr|mrs|ms|miss|mx|dr|prof)\.?$/i.test(x)) || src;
  return t.charAt(0).toUpperCase();
}

export default function ProfilePage() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [school, setSchool] = useState<SchoolInfo | null>(null);
  const [classes, setClasses] = useState<ClassMembership[]>([]);

  // Editable fields
  const router = useRouter();
  const [draftName, setDraftName] = useState("");
  const [draftGoal, setDraftGoal] = useState<string>("");
  const [draftLearnerProfile, setDraftLearnerProfile] = useState<LearnerProfile>("k12");
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Logo upload state (super-teacher only).
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoErr, setLogoErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setLoading(false); return; }

    // Read identity via service-role /api/auth/me — direct profiles selects
    // race RLS on the edge and intermittently returned null, which is what
    // surfaced the "Couldn't load your profile" blank state.
    const meRes = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    if (!meRes.ok) { setLoading(false); return; }
    const me = await meRes.json() as {
      uid: string;
      email: string | null;
      role: string | null;
      is_school_student: boolean;
      platform_admin: boolean;
      school_id: string | null;
      full_name: string | null;
      exam_goal: string | null;
      learner_profile?: string | null;
    };
    setEmail(me.email || "");
    const p: Profile = {
      id: me.uid,
      role: (me.role || "student") as Role,
      full_name: me.full_name,
      is_school_student: me.is_school_student,
      exam_goal: me.exam_goal,
      learner_profile: ((me as { learner_profile?: string }).learner_profile === "k12" || (me as { learner_profile?: string }).learner_profile === "competitive_exam" || (me as { learner_profile?: string }).learner_profile === "corporate") ? (me as { learner_profile: LearnerProfile }).learner_profile : "k12",
      school_id: me.school_id,
      platform_admin: me.platform_admin,
    };
    setProfile(p);
    setDraftName(p.full_name || "");
    setDraftGoal(p.exam_goal || "");
    setDraftLearnerProfile(p.learner_profile || "k12");
    const user = { id: me.uid };

    if (p?.school_id) {
      const { data: sch } = await sb
        .from("schools")
        .select("id, name, join_code, logo_url")
        .eq("id", p.school_id)
        .maybeSingle();
      setSchool((sch as SchoolInfo | null) || null);
    }

    // Class memberships — only for school students; teachers' "classes
    // they teach" is a different relationship (class_teachers) loaded
    // separately further below.
    if (p?.role === "student" && p.is_school_student) {
      const { data: rows } = await sb
        .from("class_members")
        .select("class:classes(id, name)")
        .eq("student_id", user.id);
      type Row = { class: { id: string; name: string } | null };
      const list = ((rows as unknown as Row[]) || [])
        .map((r) => r.class)
        .filter(Boolean) as ClassMembership[];
      setClasses(list);
    }
    if (p?.role === "teacher") {
      // Teachers: classes I teach (primary OR co-teacher).
      const { data: rows } = await sb
        .from("class_teachers")
        .select("class:classes(id, name)")
        .eq("teacher_id", user.id);
      type Row = { class: { id: string; name: string } | null };
      const list = ((rows as unknown as Row[]) || [])
        .map((r) => r.class)
        .filter(Boolean) as ClassMembership[];
      setClasses(list);
    }

    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function saveProfile() {
    if (!profile) return;
    setSaveErr(null); setSaveOk(false);
    setSaving(true);
    try {
      const sb = supabaseBrowser();
      const patch: Record<string, string | null> = {};
      // Name is editable only for independent students and teachers /
      // super-teachers. School students get their name set by the admin.
      const nameEditable =
        (profile.role === "student" && !profile.is_school_student) ||
        profile.role === "teacher" ||
        profile.role === "super_teacher";
      if (nameEditable) {
        patch.full_name = draftName.trim() || null;
      }
      if (profile.role === "student" && !profile.is_school_student) {
        patch.exam_goal = draftGoal || null;
      }
      patch.learner_profile = draftLearnerProfile;
      const { error } = await sb.from("profiles").update(patch).eq("id", profile.id);
      if (error) throw new Error(error.message);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
      await load();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function copyJoinCode() {
    if (!school?.join_code) return;
    try {
      await navigator.clipboard.writeText(school.join_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently swallow; the code is still on screen */
    }
  }

  async function uploadLogo(file: File) {
    if (!school) return;
    setLogoErr(null); setLogoUploading(true);
    try {
      // Tiny client-side guards. The real authority is the bucket policy
      // (super-teacher of THIS school can write only under <school_id>/...).
      if (file.size > 2 * 1024 * 1024) throw new Error("Logo must be under 2 MB.");
      if (!/^image\//.test(file.type)) throw new Error("Pick an image file.");
      const sb = supabaseBrowser();
      // Path: <school_id>/<timestamp>.<ext> — timestamped so caches bust
      // cleanly on replace. We don't bother cleaning up the previous file
      // here; periodic janitor job (future) can sweep orphans.
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${school.id}/${Date.now()}.${ext || "png"}`;
      const up = await sb.storage.from("school-logos").upload(path, file, {
        cacheControl: "3600",
        upsert: false,
      });
      if (up.error) throw new Error(up.error.message);
      const { data: pub } = sb.storage.from("school-logos").getPublicUrl(path);
      const url = pub.publicUrl;
      const { error } = await sb.from("schools").update({ logo_url: url }).eq("id", school.id);
      if (error) throw new Error(error.message);
      await load();
    } catch (e) {
      setLogoErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setLogoUploading(false);
    }
  }

  async function removeLogo() {
    if (!school) return;
    setLogoErr(null);
    try {
      const sb = supabaseBrowser();
      // Clear the URL — the storage object stays for now (paranoid retain
      // for a beat in case the user wants to revert; janitor job sweeps).
      const { error } = await sb.from("schools").update({ logo_url: null }).eq("id", school.id);
      if (error) throw new Error(error.message);
      await load();
    } catch (e) {
      setLogoErr(e instanceof Error ? e.message : "Could not remove logo");
    }
  }

  if (loading) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }
  if (!profile) {
    return (
      <div className="max-w-3xl mx-auto py-10 text-center">
        <div className="muted">Couldn&apos;t load your profile. Please sign in again.</div>
      </div>
    );
  }

  const isIndependentStudent = profile.role === "student" && !profile.is_school_student;
  const isSchoolStudent      = profile.role === "student" && !!profile.is_school_student;
  const isTeacher            = profile.role === "teacher";
  const isSuperTeacher       = profile.role === "super_teacher";
  const isPlatformAdmin      = !!profile.platform_admin;

  const nameEditable =
    isIndependentStudent || isTeacher || isSuperTeacher;
  const showPasswordChange = !isSchoolStudent;
  const show2FA            = !isSchoolStudent;

  // The Profile page lives outside any role-specific layout, so we
  // explicitly route the back link to the right home for the user.
  // Platform admin -> /admin; super-teacher -> /school; everyone
  // else -> /<role>.
  const homeHref =
    isPlatformAdmin ? "/admin" :
    isSuperTeacher ? "/school" :
    `/${profile.role}`;

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <button
        type="button"
        onClick={() => router.push(homeHref)}
        className="text-xs muted hover:text-emerald-700 inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft size={12} /> Back to dashboard
      </button>

      {/* Hero strip — same gradient pattern as the teacher home so the
          settings area feels part of the same product, not a different
          one. Avatar (initial-letter circle), name, role caption, plan
          badge on the right. */}
      <div
        className="rounded-2xl px-5 py-5"
        style={{
          background: "linear-gradient(135deg, color-mix(in oklab, var(--brand-100, #d1fae5) 50%, var(--color-card, #fff)) 0%, color-mix(in oklab, #e0f2fe 35%, var(--color-card, #fff)) 100%)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 min-w-0">
            {isSuperTeacher && school?.logo_url ? (
              <img
                src={school.logo_url}
                alt={`${school.name} logo`}
                className="w-14 h-14 rounded-full object-cover shrink-0 border"
                style={{ borderColor: "var(--color-border)", background: "var(--color-card)" }}
              />
            ) : (
              <div
                className="w-14 h-14 rounded-full grid place-items-center text-2xl font-bold shrink-0"
                style={{
                  background: "var(--brand-200, #a7f3d0)",
                  color: "var(--brand-800, #065f46)",
                }}
                aria-hidden
              >
                {initialOf(profile.full_name || "", email)}
              </div>
            )}
            <div className="min-w-0">
              <h1 className="h1 truncate">{profile.full_name || email || "You"}</h1>
              <p className="muted text-sm mt-0.5 capitalize">
                {isPlatformAdmin
                  ? "Platform admin"
                  : isSuperTeacher
                  ? "School admin (super-teacher)"
                  : isTeacher
                  ? "Teacher"
                  : isSchoolStudent
                  ? "School student"
                  : "Independent student"}
                {school?.name && <> &middot; {school.name}</>}
              </p>
            </div>
          </div>
          <CurrentPlanBadge />
        </div>
      </div>

      {/* ========== Personal details (name + goal) ========== */}
      <div className="card mt-5">
        <h2 className="h2 mb-3 flex items-center gap-2"><UserIcon size={18} /> Personal details</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Full name</label>
            <input
              className="input"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              disabled={!nameEditable}
              placeholder={nameEditable ? "Your name" : ""}
            />
            {!nameEditable && (
              <p className="text-xs muted mt-1">
                Your school admin manages this. Ask them to update if it&apos;s wrong.
              </p>
            )}
          </div>
          <div>
            <label className="label flex items-center gap-1.5"><Mail size={12} /> Email</label>
            <input className="input" value={email} disabled />
            <p className="text-xs muted mt-1">Email is read-only here. Contact support to change it.</p>
          </div>
        </div>

        {isIndependentStudent && (
          <div className="mt-4">
            <label className="label flex items-center gap-1.5">
              <GraduationCap size={12} /> Exam goal
            </label>
            <select
              className="input"
              value={draftGoal}
              onChange={(e) => setDraftGoal(e.target.value)}
            >
              <option value="">— Not set —</option>
              {STUDENT_GOALS.map((g) => (
                <option key={g.id} value={g.id}>{g.label}</option>
              ))}
            </select>
            <p className="text-xs muted mt-1">
              Your goal personalises every recommendation on your dashboard.
            </p>
          </div>
        )}

        {/* Q2: learner profile dropdown — visible to all roles. */}
        <div className="mt-4">
          <label className="label">What kind of learning are you here for?</label>
          <select
            className="input"
            value={draftLearnerProfile}
            onChange={(e) => setDraftLearnerProfile(e.target.value as LearnerProfile)}
          >
            <option value="k12">K-12 / school</option>
            <option value="competitive_exam">Competitive exam (CAT, JEE, NEET, GRE…)</option>
            <option value="corporate">Professional / training (Java, AWS, mainframe…)</option>
          </select>
          <p className="text-xs muted mt-1">
            Tunes the &quot;What kind of test are you making?&quot; suggestions on the generate page. Doesn&apos;t change any other vocabulary.
          </p>
        </div>

        {(nameEditable || isIndependentStudent) && (
          <div className="mt-4 flex items-center gap-3">
            <button type="button"
              className="btn btn-primary inline-flex items-center gap-1.5"
              onClick={saveProfile}
              disabled={saving}
            >
              {saving ? <><span className="spinner" /> Saving&hellip;</> : <><Save size={14} /> Save changes</>}
            </button>
            {saveOk && <span className="text-sm text-emerald-700 inline-flex items-center gap-1"><Check size={14} /> Saved</span>}
            {saveErr && <span className="text-sm text-red-700">{saveErr}</span>}
          </div>
        )}
      </div>

      {/* ========== School / classes context ========== */}
      {(isSchoolStudent || isTeacher) && classes.length > 0 && (
        <div className="card mt-4">
          <h2 className="h2 mb-2 flex items-center gap-2">
            <Users size={18} /> {isTeacher ? "Classes you teach" : "Your classes"}
          </h2>
          <ul className="divide-y divide-slate-100">
            {classes.map((c) => (
              <li key={c.id} className="py-2 flex items-center justify-between">
                <span className="font-medium">{c.name}</span>
                {isTeacher && (
                  <Link
                    href={`/teacher/classes/${c.id}`}
                    className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"
                  >
                    Open <ArrowRight size={12} />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ========== School identity (super-teacher) ========== */}
      {isSuperTeacher && school && (
        <div className="card mt-4">
          <h2 className="h2 mb-3 flex items-center gap-2"><Building2 size={18} /> Your school</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs muted uppercase tracking-wide font-semibold">School name</div>
              <div className="font-semibold mt-1">{school.name}</div>
              <p className="text-xs muted mt-1">
                Rename from the <Link href="/school" className="underline">School Home</Link> page.
              </p>
            </div>
            <div>
              <div className="text-xs muted uppercase tracking-wide font-semibold">Join code</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="text-base font-mono font-bold px-2 py-1 bg-slate-100 rounded">
                  {school.join_code || "—"}
                </code>
                {school.join_code && (
                  <button type="button"
                    className="btn btn-ghost text-xs inline-flex items-center gap-1"
                    onClick={copyJoinCode}
                    title="Copy school join code"
                  >
                    {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                )}
              </div>
              <p className="text-xs muted mt-1">
                Teachers paste this on their dashboard to join your school.
              </p>
            </div>
          </div>

          {/* Logo upload — sub-section inside Your school. Surfaces
              wherever the school is branded (sidebar header, profile
              hero, /school home). Storage policy enforces "only this
              school's super-teacher can upload to /<school_id>/...". */}
          <div className="mt-5 pt-5" style={{ borderTop: "1px solid var(--color-border)" }}>
            <div className="text-xs muted uppercase tracking-wide font-semibold flex items-center gap-1.5">
              <ImageIcon size={12} /> School logo
            </div>
            <div className="mt-3 flex items-start gap-4 flex-wrap">
              {school.logo_url ? (
                <img
                  src={school.logo_url}
                  alt={`${school.name} logo`}
                  className="w-20 h-20 rounded-lg object-cover border"
                  style={{ borderColor: "var(--color-border)" }}
                />
              ) : (
                <div
                  className="w-20 h-20 rounded-lg grid place-items-center muted text-xs"
                  style={{ background: "var(--color-bg-soft)", border: "1px dashed var(--color-border)" }}
                >
                  No logo
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs muted leading-relaxed">
                  PNG, JPG, or SVG up to 2 MB. Square images render best
                  (the logo is clipped to a circle in the sidebar and a
                  rounded square here).
                </p>
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <label className="btn btn-secondary text-xs cursor-pointer inline-flex items-center gap-1.5">
                    <ImageIcon size={12} />
                    {logoUploading ? "Uploading…" : school.logo_url ? "Replace logo" : "Upload logo"}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={logoUploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadLogo(f);
                        // Reset value so re-picking the same file fires onChange.
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {school.logo_url && (
                    <button
                      type="button"
                      onClick={removeLogo}
                      className="btn btn-ghost text-xs text-red-600 inline-flex items-center gap-1.5"
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  )}
                </div>
                {logoErr && (
                  <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1.5 rounded">
                    {logoErr}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== Account & security ========== */}
      <div className="card mt-4">
        <h2 className="h2 mb-3 flex items-center gap-2"><ShieldCheck size={18} /> Account &amp; security</h2>
        <div className="space-y-2">
          {showPasswordChange && (
            <Link
              href="/auth/set-password"
              className="sidebar-link flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
            >
              <KeyRound size={16} /> Change password
              <ArrowRight size={14} className="ml-auto" />
            </Link>
          )}
          {show2FA && (
            <Link
              href="/settings/security"
              className="sidebar-link flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
            >
              <ShieldCheck size={16} /> Two-factor authentication
              <ArrowRight size={14} className="ml-auto" />
            </Link>
          )}
          {isPlatformAdmin && (
            <Link
              href="/admin/security"
              className="sidebar-link flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
            >
              <ShieldCheck size={16} /> Platform admin security
              <ArrowRight size={14} className="ml-auto" />
            </Link>
          )}
          {isSchoolStudent && (
            <p className="text-xs muted px-3 py-2">
              Your teacher manages your password and login. Ask them to reset it if you need to.
            </p>
          )}
        </div>
      </div>

      {/* ========== Appearance ========== */}
      <div className="card mt-4">
        <h2 className="h2 mb-3 flex items-center gap-2"><Palette size={18} /> Appearance</h2>
        <Link
          href="/settings/appearance"
          className="sidebar-link flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
        >
          <Palette size={16} /> Theme &amp; mode
          <ArrowRight size={14} className="ml-auto" />
        </Link>
        <p className="text-xs muted mt-2">
          Pick a colour palette and choose light or dark.
        </p>
      </div>
    </div>
  );
}
