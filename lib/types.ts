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
