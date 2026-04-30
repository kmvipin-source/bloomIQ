import type { BloomLevel } from "./bloom";

export type Profile = {
  id: string;
  role: "teacher" | "student" | "super_teacher";
  full_name: string | null;
  school: string | null;
  grade: string | null;
  // BloomIQ staff flag — gates /admin/* pages. Distinct from super_teacher,
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
// Plan-Admin types — see migration 25 + lib/features.ts.
// =====================================================================

export type PlanTier =
  | "free"
  | "premium"
  | "premium_plus"
  | "school_pilot"
  | "school_standard"
  | "school_plus";

export type PlanStatus = "draft" | "pending_review" | "active" | "archived";

export type PlanPricingModel = "fixed" | "per_student";

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
  status: PlanStatus;
  effective_from: string | null;
  effective_to: string | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  // Pricing model — "fixed" uses price_paise directly (Free / Premium /
  // Premium Plus). "per_student" uses per_student_price_paise × the
  // school's student headcount (School Pilot / Standard / Plus). See
  // migration 27.
  pricing_model: PlanPricingModel;
  per_student_price_paise: number;
  min_students: number;
  max_students: number | null;
};

export type PlanAuditEvent = {
  id: number;
  plan_id: string;
  actor_id: string | null;
  // 'created' | 'edited' | 'submitted' | 'approved' | 'rejected' |
  // 'archived' | 'price_change' | 'features_change' — extensible.
  action: string;
  payload: Record<string, unknown>;
  created_at: string;
};

