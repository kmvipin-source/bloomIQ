import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import type {
  PlanProposalKind,
  PlanProposalPayload,
  PlanProposalStatus,
} from "@/lib/types";

export const runtime = "nodejs";

/**
 * /api/admin/plan-proposals
 *
 * The single mutation surface for the plan catalogue. Direct edits/inserts
 * via /api/admin/plans/* are deprecated (410 Gone post-migration-43). All
 * changes flow through proposals → review → approval.
 *
 * GET   — list proposals with status/kind/scope filters for the queue UI.
 * POST  — create a new proposal (kind='edit' modifies a live plan, kind='create'
 *         mints a new SKU). The proposed payload is stored as JSONB; nothing
 *         hits the live `plans` table until an approver applies it.
 *
 * Auth: caller must be `profiles.platform_admin = true`.
 */

// ------- shared admin gate (same pattern as /api/admin/plans/route.ts) ----

export async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) {
    return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const sb = supabaseServer(token);
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
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
}

// ------- payload validation -----------------------------------------------

const VALID_TIERS = new Set([
  "free",
  "premium",
  "premium_plus",
  "school_pilot",
  "school_standard",
  "school_plus",
]);

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

/**
 * Coerce + validate a body payload into a clean PlanProposalPayload.
 * Returns either { ok: true, payload } or { ok: false, error }.
 *
 * For kind='create': slug + tier are required.
 * For kind='edit': slug + tier are ignored (immutable on the live row).
 */
export function validatePayload(
  body: Record<string, unknown>,
  kind: PlanProposalKind,
): { ok: true; payload: PlanProposalPayload } | { ok: false; error: string } {
  // slug + tier (only matter for 'create')
  let slug: string | undefined;
  let tier: PlanProposalPayload["tier"] | undefined;
  if (kind === "create") {
    slug = String(body.slug ?? "").trim().toLowerCase();
    if (!slug) return { ok: false, error: "slug is required for new SKUs" };
    if (!SLUG_RE.test(slug))
      return {
        ok: false,
        error:
          "slug must be 2–64 chars, lowercase letters/digits/hyphen/underscore only, not starting or ending with a separator",
      };
    const t = String(body.tier ?? "").trim();
    if (!t) return { ok: false, error: "tier is required for new SKUs" };
    if (!VALID_TIERS.has(t))
      return { ok: false, error: `tier must be one of: ${Array.from(VALID_TIERS).join(", ")}` };
    tier = t as PlanProposalPayload["tier"];
  }

  // label — required everywhere.
  const label = String(body.label ?? "").trim();
  if (!label) return { ok: false, error: "label is required" };
  if (label.length > 200) return { ok: false, error: "label must be ≤ 200 chars" };

  // blurb — nullable, capped.
  let blurb: string | null;
  if (body.blurb === null || body.blurb === undefined || body.blurb === "") {
    blurb = null;
  } else if (typeof body.blurb === "string") {
    blurb = body.blurb.trim();
    if (blurb.length > 500) return { ok: false, error: "blurb must be ≤ 500 chars" };
  } else {
    return { ok: false, error: "blurb must be a string or null" };
  }

  // feature_summary, features — string arrays.
  const feature_summary = Array.isArray(body.feature_summary)
    ? body.feature_summary.map((s: unknown) => String(s)).filter(Boolean)
    : [];
  const features = Array.isArray(body.features)
    ? body.features.map((s: unknown) => String(s)).filter(Boolean)
    : [];

  // numeric: price_paise, period_days, per_student_price_paise, min_students.
  const price_paise =
    typeof body.price_paise === "number" && Number.isFinite(body.price_paise)
      ? Math.max(0, Math.floor(body.price_paise))
      : 0;
  const period_days =
    typeof body.period_days === "number" && Number.isFinite(body.period_days)
      ? Math.max(0, Math.floor(body.period_days))
      : 30;
  const per_student_price_paise =
    typeof body.per_student_price_paise === "number" && Number.isFinite(body.per_student_price_paise)
      ? Math.max(0, Math.floor(body.per_student_price_paise))
      : 0;
  const min_students =
    typeof body.min_students === "number" && Number.isFinite(body.min_students)
      ? Math.max(0, Math.floor(body.min_students))
      : 0;
  let max_students: number | null = null;
  if (typeof body.max_students === "number" && Number.isFinite(body.max_students)) {
    if (body.max_students <= 0)
      return { ok: false, error: "max_students must be > 0 or null" };
    max_students = Math.floor(body.max_students);
  } else if (body.max_students === null) {
    max_students = null;
  }

  // currency — 3-letter uppercase.
  const currency = String(body.currency ?? "INR").toUpperCase();
  if (currency.length !== 3)
    return { ok: false, error: "currency must be a 3-letter ISO code" };

  // pricing_model — must be valid.
  const pricing_model =
    body.pricing_model === "fixed" || body.pricing_model === "per_student"
      ? body.pricing_model
      : (kind === "create" && tier?.startsWith("school_") ? "per_student" : "fixed");
  if (pricing_model === "per_student" && per_student_price_paise <= 0) {
    return {
      ok: false,
      error:
        "per_student plans need per_student_price_paise > 0 (DB constraint plans_per_student_price_required)",
    };
  }

  // razorpay_plan_id — optional, deferred work.
  let razorpay_plan_id: string | null = null;
  if (typeof body.razorpay_plan_id === "string" && body.razorpay_plan_id.trim()) {
    razorpay_plan_id = body.razorpay_plan_id.trim();
  } else if (body.razorpay_plan_id === null) {
    razorpay_plan_id = null;
  }

  return {
    ok: true,
    payload: {
      slug,
      tier,
      label,
      blurb,
      feature_summary,
      price_paise,
      currency,
      period_days,
      features,
      pricing_model,
      per_student_price_paise,
      min_students,
      max_students,
      razorpay_plan_id,
    },
  };
}

// ------- GET: list proposals ---------------------------------------------

/**
 * Filters supported via query string (matches the queue tabs):
 *   ?scope=mine           → my drafts (status=open, created_by=me)
 *   ?scope=for_me         → awaiting MY approval (status=open, created_by!=me, two-eyes)
 *   ?scope=others_drafts  → others' drafts (status=open, created_by!=me)
 *                           [shown to me when I'm the bootstrap solo admin]
 *   ?status=approved      → recently approved
 *   ?status=rejected      → rejected
 *   (no params)           → all proposals, newest first
 *
 * Each row includes a tiny target/parent-plan summary so the queue list can
 * render "Edit Premium Monthly" without a second round-trip.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;

    const url = new URL(req.url);
    const scope = url.searchParams.get("scope");
    const status = url.searchParams.get("status") as PlanProposalStatus | null;
    const me = auth.user.id;

    const admin = supabaseAdmin();
    let q = admin
      .from("plan_change_proposals")
      .select(
        "id, kind, target_plan_id, parent_plan_id, proposed, status, created_by, created_at, approved_by, approved_at, approved_with_edits, bootstrap_self_approve, rejected_by, rejected_at, rejection_reason, withdrawn_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);

    if (scope === "mine") {
      q = q.eq("status", "open").eq("created_by", me);
    } else if (scope === "for_me") {
      q = q.eq("status", "open").neq("created_by", me);
    } else if (scope === "others_drafts") {
      q = q.eq("status", "open").neq("created_by", me);
    } else if (status) {
      q = q.eq("status", status);
    }

    const { data: rows, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Hydrate target + parent plan summaries (slug + label only) so the
    // queue UI can render "Edit Premium Monthly" without a second hop.
    const planIds = new Set<string>();
    for (const r of rows || []) {
      if (r.target_plan_id) planIds.add(r.target_plan_id);
      if (r.parent_plan_id) planIds.add(r.parent_plan_id);
    }
    const planSummaries = new Map<string, { id: string; slug: string; label: string; tier: string }>();
    if (planIds.size > 0) {
      const { data: plans } = await admin
        .from("plans")
        .select("id, slug, label, tier")
        .in("id", Array.from(planIds));
      for (const p of (plans as Array<{ id: string; slug: string; label: string; tier: string }>) || []) {
        planSummaries.set(p.id, p);
      }
    }

    // Hydrate creator names for the queue list.
    const userIds = new Set<string>();
    for (const r of rows || []) {
      userIds.add(r.created_by);
      if (r.approved_by) userIds.add(r.approved_by);
      if (r.rejected_by) userIds.add(r.rejected_by);
    }
    const profileSummaries = new Map<string, { id: string; full_name: string | null }>();
    if (userIds.size > 0) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", Array.from(userIds));
      for (const p of (profs as Array<{ id: string; full_name: string | null }>) || []) {
        profileSummaries.set(p.id, p);
      }
    }

    const hydrated = (rows || []).map((r) => ({
      ...r,
      target_plan: r.target_plan_id ? planSummaries.get(r.target_plan_id) || null : null,
      parent_plan: r.parent_plan_id ? planSummaries.get(r.parent_plan_id) || null : null,
      created_by_name: profileSummaries.get(r.created_by)?.full_name || null,
      approved_by_name: r.approved_by ? profileSummaries.get(r.approved_by)?.full_name || null : null,
      rejected_by_name: r.rejected_by ? profileSummaries.get(r.rejected_by)?.full_name || null : null,
    }));

    return NextResponse.json({ ok: true, proposals: hydrated, current_user_id: me });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 },
    );
  }
}

// ------- POST: create a proposal -----------------------------------------

/**
 * Body:
 *   { kind: 'edit', target_plan_id, proposed: PlanProposalPayload }
 *   { kind: 'create', parent_plan_id?: string, proposed: PlanProposalPayload }
 *
 * For kind='edit', target_plan_id must reference a status='active' plan.
 * The DB unique index `proposals_one_open_edit_per_target` blocks concurrent
 * open edits on the same target — we surface that as a 409.
 *
 * For kind='create', parent_plan_id is informational only (audit: "cloned
 * from Premium Monthly"). The proposed.slug must be unique vs. any live
 * plan AND vs. any other open create-proposal (we check the latter
 * explicitly here since there's no unique index on JSON payload fields).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const kind = body.kind === "create" ? "create" : body.kind === "edit" ? "edit" : null;
    if (!kind) {
      return NextResponse.json(
        { error: "kind must be 'edit' or 'create'" },
        { status: 400 },
      );
    }

    const targetId = typeof body.target_plan_id === "string" ? body.target_plan_id : null;
    const parentId = typeof body.parent_plan_id === "string" ? body.parent_plan_id : null;

    if (kind === "edit" && !targetId) {
      return NextResponse.json(
        { error: "target_plan_id is required for kind='edit'" },
        { status: 400 },
      );
    }
    if (kind === "create" && targetId) {
      return NextResponse.json(
        { error: "target_plan_id is forbidden for kind='create'" },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();

    // For 'edit': verify target exists and is currently active. We don't
    // allow editing archived plans (admin would archive-then-create-new).
    if (kind === "edit") {
      const { data: target } = await admin
        .from("plans")
        .select("id, slug, status")
        .eq("id", targetId!)
        .maybeSingle();
      if (!target) return NextResponse.json({ error: "target_plan not found" }, { status: 404 });
      if (target.status !== "active")
        return NextResponse.json(
          { error: `target_plan is not active (status=${target.status})` },
          { status: 409 },
        );
    }

    // For 'create': if a parent_plan_id was supplied, sanity-check it exists.
    if (kind === "create" && parentId) {
      const { data: parent } = await admin
        .from("plans")
        .select("id")
        .eq("id", parentId)
        .maybeSingle();
      if (!parent)
        return NextResponse.json({ error: "parent_plan not found" }, { status: 404 });
    }

    // Validate the proposed payload.
    const proposedRaw =
      typeof body.proposed === "object" && body.proposed !== null
        ? (body.proposed as Record<string, unknown>)
        : {};
    const v = validatePayload(proposedRaw, kind);
    if (!v.ok) return NextResponse.json({ error: (v as unknown as { error: string }).error }, { status: 400 });

    // For 'create', confirm the slug isn't already taken by a live plan or
    // another open create-proposal. Live-plan uniqueness is enforced by
    // `plans_one_active_per_slug`; the open-proposal check is in app code.
    if (kind === "create" && v.payload.slug) {
      const { data: existingPlan } = await admin
        .from("plans")
        .select("id")
        .eq("slug", v.payload.slug)
        .maybeSingle();
      if (existingPlan) {
        return NextResponse.json(
          { error: `A plan with slug "${v.payload.slug}" already exists. Edit it instead, or pick a different slug.` },
          { status: 409 },
        );
      }
      // Detect duplicate open create-proposal for the same slug. Race-safe
      // enough — a follow-up duplicate would just block at apply-time.
      const { data: dupProposals } = await admin
        .from("plan_change_proposals")
        .select("id, proposed")
        .eq("status", "open")
        .eq("kind", "create");
      for (const dp of (dupProposals as Array<{ id: string; proposed: PlanProposalPayload }>) || []) {
        if (dp.proposed?.slug === v.payload.slug) {
          return NextResponse.json(
            {
              error: `Another open proposal is already trying to create slug "${v.payload.slug}". Resolve that one first.`,
              conflict_proposal_id: dp.id,
            },
            { status: 409 },
          );
        }
      }
    }

    const { data: created, error: insErr } = await admin
      .from("plan_change_proposals")
      .insert({
        kind,
        target_plan_id: kind === "edit" ? targetId : null,
        parent_plan_id: kind === "create" ? parentId : null,
        proposed: v.payload,
        status: "open",
        created_by: auth.user.id,
      })
      .select()
      .single();
    if (insErr) {
      // Surface the unique-index violation specifically.
      if (insErr.message.toLowerCase().includes("proposals_one_open_edit_per_target")) {
        return NextResponse.json(
          { error: "An open edit-proposal already exists for this plan. Resolve or withdraw it first." },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, proposal: created });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 500 },
    );
  }
}
