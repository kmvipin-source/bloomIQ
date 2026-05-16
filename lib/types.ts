import type { BloomLevel } from "./bloom";

export type Profile = {
  id: string;
  role: "teacher" | "student" | "super_teacher";
  full_name: string | null;
  school: string | null;
  grade: string | null;
  // ZCORIQ staff flag — gates /admin/* pages. Distinct from super_teacher,
  // which is a per-school admin role. See migration 22.
  platform_admin: boolean;
  // Independent-student onboarding answer — drives tile prioritisation on
  // /student. Set the first time the student lands on the dashboard. Null
  // for school students and for independent students who pre-date the
  // onboarding flow. See migration 24.
  exam_goal: string | null;
  exam_goal_set_at: string | null;
  // Visual preference — server-persisted copy of the localStorage value
  // set by ThemeProvider so the choice follows the user across devices.
  // See migration 29. Constrained to the 5 theme names + 2 color modes.
  theme: "emerald" | "indigo" | "rose" | "amber" | "slate";
  color_mode: "light" | "dark";
  created_at: string;
};

export type School = {
  id: string;
  name: string;
  super_teacher_id: string | null;
  join_code: string | null;
  // Invite tracking populated when the school is provisioned by a platform
  // admin via /admin/onboard-school. Null for legacy / self-created schools.
  invited_admin_email: string | null;
  invited_at: string | null;
  onboarded_by: string | null;
  created_at: string;
};

export type Question = {
  id: string;
  owner_id: string;
  topic: string | null;
  bloom_level: BloomLevel;
  stem: string;
  options: string[]; // length 4
  correct_index: number;
  explanation: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  // 2026-05-15 (migration 90): teaching/learning context this question was
  // generated for (mirrors profiles.exam_goal slug — "class_10_boards",
  // "jee_main", etc.). NULL = legacy row from before tagging shipped.
  category?: string | null;
  // 2026-05-16 (migration 91): generation provenance blob. See
  // lib/qgenPipeline.ts → GenerationMeta for the canonical shape. Loose
  // typing here because the column is jsonb and we read it from many
  // surfaces with overlapping interest — the UI only narrows the fields
  // it actually reads (verifier.status, bloom_disputed, etc.). Default
  // is {} for rows generated before the pipeline shipped.
  generation_meta?: {
    route?: string;
    intent?: string;
    requested_bloom?: BloomLevel;
    prompt_version?: string;
    verifier?: {
      status?: "agreed" | "disputed" | "skipped";
      reason?: string;
      model?: string;
      llm_correct?: string;
      verifier_correct?: string;
    };
    embedding_present?: boolean;
    dedup?: {
      jaccard_filtered?: number;
      cosine_in_batch_filtered?: number;
      cosine_history_filtered?: number;
    };
    retry_count?: number;
    generated_at?: string;
    bloom_disputed?: boolean;
    bloom_actual?: BloomLevel | null;
    bloom_rationale?: string;
    sanitizer_fired?: boolean;
  } | null;
};

export type Quiz = {
  id: string;
  owner_id: string;
  name: string;
  subject: string | null;
  topic_family: string | null;
  code: string;
  time_limit_minutes: number;
  bloom_filter: BloomLevel[] | null;
  active: boolean;
  created_at: string;
  /**
   * Per-test marking scheme (migration 76). NULL means legacy +1/0/0.
   * Resolved through `lib/scoring.ts → resolveScheme()` at every read
   * site so consumers don't need to know about the NULL case.
   */
  marking_scheme: unknown | null;
};

export type QuizAttempt = {
  id: string;
  quiz_id: string;
  student_id: string;
  started_at: string;
  submitted_at: string | null;
  score: number;
  total: number;
  time_taken_seconds: number | null;
};

export type AttemptAnswer = {
  id: string;
  attempt_id: string;
  question_id: string;
  selected_index: number | null;
  is_correct: boolean | null;
  bloom_level: BloomLevel;
};

export type Alert = {
  id: string;
  student_id: string;
  quiz_id: string | null;
  kind: string;
  message: string;
  created_at: string;
  dismissed: boolean;
};

export type Class = {
  id: string;
  owner_id: string;
  name: string;
  grade: string | null;
  subject: string | null;
  section: string | null;
  join_code: string;
  created_at: string;
  status?: "active" | "inactive" | null;
};

export type ClassMember = {
  class_id: string;
  student_id: string;
  joined_at: string;
};

export type ClassTeacher = {
  class_id: string;
  teacher_id: string;
  role: "primary" | "co";
  subject: string | null;
  added_at: string;
};

export type ExamQuestionType = "mcq" | "true_false" | "fill_blank" | "short_answer" | "long_answer" | "numerical";

export type ExamPaper = {
  id: string;
  owner_id: string;
  name: string;
  school_name: string | null;
  class_grade: string | null;
  subject: string | null;
  exam_date: string | null;
  duration_minutes: number | null;
  total_marks: number;
  instructions: string | null;
  status: "draft" | "finalized";
  created_at: string;
};

export type ExamPaperQuestion = {
  id: string;
  paper_id: string;
  section_name: string;
  position: number;
  question_type: ExamQuestionType;
  stem: string;
  options: string[] | null;
  correct_answer: string | null;
  explanation: string | null;
  marks: number;
  bloom_level: BloomLevel | null;
  created_at: string;
};

export type QuizAssignment = {
  id: string;
  quiz_id: string;
  class_id: string | null;
  student_id: string | null;
  assigned_by: string | null;
  due_at: string | null;
  created_at: string;
};

// =====================================================================
// Plan-Admin types — see migration 25 (initial), migration 32 (workflow
// columns restored), and migration 43 (proposal-workflow side table).
// =====================================================================

export type PlanTier =
  | "free"
  | "premium"
  | "premium_plus"
  | "school_pilot"
  | "school_standard"
  | "school_plus";

export type PlanPricingModel = "fixed" | "per_student";

/** Plan lifecycle on the live `plans` table. Post-migration-43 only `active`
 *  rows live in `plans` — drafts and pending reviews are held in
 *  `plan_change_proposals`. The `pending_review` and `draft` values are
 *  retained in the DB CHECK for legacy compatibility but the API never
 *  writes them on `plans`. */
export type PlanStatus = "draft" | "pending_review" | "active" | "archived";

/**
 * A SKU in the catalogue. Post-migration-43 every row is a live, purchasable
 * SKU (status='active'). Drafts and approval workflow live in
 * `plan_change_proposals`; on approval those are flattened into INSERT (for
 * kind='create') or UPDATE (for kind='edit') against this table.
 *
 * When a proposal is approved:
 *   - new signups + renewals see the new price + features immediately
 *   - existing subscribers keep their locked price
 *     (`subscriptions.price_paid_paise`) until `expires_at`, but get any
 *     new features live
 *
 * Audit columns (`created_by`, `approved_by`, `approved_at`,
 * `effective_from`, `effective_to`) are stamped from the approving
 * proposal. In bootstrap mode (single platform admin), `approved_by` is
 * NULL on the row — the proposal record carries the actual approver
 * identity, since the `plans_two_eyes` CHECK forbids
 * `approved_by = created_by` at the row level.
 */
export type Plan = {
  id: string;
  slug: string;
  tier: PlanTier;
  label: string;
  blurb: string | null;
  feature_summary: string[];
  // Razorpay convention — always paise.
  price_paise: number;
  currency: string;
  period_days: number;
  // Array of feature keys from lib/features.ts.
  features: string[];
  created_at: string;
  updated_at: string;
  // Pricing model — "fixed" uses price_paise directly (Free / Premium /
  // Premium Plus). "per_student" uses per_student_price_paise × the
  // school's student headcount (School Pilot / Standard / Plus). See
  // migration 27.
  pricing_model: PlanPricingModel;
  per_student_price_paise: number;
  min_students: number;
  max_students: number | null;
  // ---- Workflow / audit columns (migration 32 + 43) ----
  status: PlanStatus;
  created_by: string | null;
  approved_by: string | null;          // null in bootstrap mode
  approved_at: string | null;          // null in bootstrap mode
  effective_from: string | null;
  effective_to: string | null;
  // ---- Razorpay sync (migration 43) ----
  // Null until the deferred Razorpay-sync work lands. Null SKUs are
  // admin-visible but not purchasable.
  razorpay_plan_id: string | null;
};

// =====================================================================
// Plan change proposals — migration 43.
// =====================================================================

/** 'edit' modifies an existing live plan; 'create' mints a new SKU. */
export type PlanProposalKind = "edit" | "create";

/** Lifecycle of a proposal. `open` is the only mutable state — once the
 *  proposal lands in `approved`, `rejected`, or `withdrawn` it's frozen as
 *  the audit record. */
export type PlanProposalStatus = "open" | "approved" | "rejected" | "withdrawn";

/** The proposal's `proposed` JSONB payload. Mirrors `Plan` minus the
 *  identity / audit / timestamp fields (those are stamped at apply-time on
 *  the live row, not chosen by the proposer). */
export type PlanProposalPayload = {
  // Identity for kind='create'; ignored for kind='edit' (slug is immutable
  // post-creation, matches existing PUT route's behavior).
  slug?: string;
  tier?: PlanTier;
  // Editable everywhere.
  label: string;
  blurb: string | null;
  feature_summary: string[];
  price_paise: number;
  currency: string;
  period_days: number;
  features: string[];
  pricing_model: PlanPricingModel;
  per_student_price_paise: number;
  min_students: number;
  max_students: number | null;
  // Optional — only set when an admin pasted in a Razorpay plan id during
  // edit/create. Until the deferred Razorpay-sync work lands, this is
  // typically null.
  razorpay_plan_id?: string | null;
};

export type PlanChangeProposal = {
  id: string;
  kind: PlanProposalKind;
  // Live plan being edited (kind='edit') or null (kind='create').
  target_plan_id: string | null;
  // Template the proposer cloned from. Informational only.
  parent_plan_id: string | null;
  proposed: PlanProposalPayload;
  // Snapshot of `proposed` as the creator submitted it. Set only when the
  // approver edited the payload before approving (in which case `proposed`
  // is the approver's final version).
  proposed_at_submit: PlanProposalPayload | null;
  status: PlanProposalStatus;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_with_edits: boolean;
  // True when self-approval was permitted because exactly one platform
  // admin existed at approval time.
  bootstrap_self_approve: boolean;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  withdrawn_at: string | null;
};

