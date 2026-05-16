-- supabase/migrations/94_teacher_assignments.sql
-- ==========================================================================
-- Tables that back the teacher-side flashcards & practice fan-outs (P2.8).
--
-- Why
-- ---
-- /api/teacher/assign-flashcards and /api/teacher/assign-practice
-- queue per-student work that the student's client picks up on next
-- sign-in. Both need persistence rows.
--
-- Design
-- ------
-- One table per kind, kept narrow on purpose:
--   - flashcard_assignments: the deck CONTENT is shared, so we store
--     the cards JSON once per student row (cheap; ~10 cards × ~200
--     chars). Each student then runs through spaced repetition
--     independently of peers.
--   - practice_assignments: a queue ticket only — the actual question
--     generation happens when the STUDENT'S client picks the ticket
--     up (so adaptive practice runs under the student's RLS context,
--     mining their personal weakspots). Status flips queued →
--     generating → ready → completed.
--
-- Both tables enforce RLS so a student only ever sees their own row.
-- Teachers see rows they created via the teacher_id column (a separate
-- policy for the dashboard view).
-- ==========================================================================

-- ─── Flashcard assignments ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS flashcard_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id  uuid NOT NULL REFERENCES auth.users(id),
  student_id  uuid NOT NULL REFERENCES auth.users(id),
  topic       text NOT NULL,
  cards       jsonb NOT NULL,    -- [{ front, back, bloom_level? }, ...]
  source      text NOT NULL DEFAULT 'teacher_assigned',
  created_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz       -- set when the student finishes the deck
);

CREATE INDEX IF NOT EXISTS flashcard_assignments_student_idx
  ON flashcard_assignments (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flashcard_assignments_class_idx
  ON flashcard_assignments (class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flashcard_assignments_teacher_idx
  ON flashcard_assignments (teacher_id, created_at DESC);

ALTER TABLE flashcard_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY flashcard_assignments_student_read
  ON flashcard_assignments
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY flashcard_assignments_student_update
  ON flashcard_assignments
  FOR UPDATE USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

CREATE POLICY flashcard_assignments_teacher_read
  ON flashcard_assignments
  FOR SELECT USING (teacher_id = auth.uid());

-- Service-role writes (the assign endpoint uses supabaseAdmin) are
-- allowed by the global service_role bypass from migration 73.

COMMENT ON TABLE flashcard_assignments IS
  'Per-student flashcard deck assigned by a teacher. Cards are duplicated per student row so each student tracks their own spaced-rep schedule. Cleaned up via CASCADE when the class is deleted.';

-- ─── Practice assignments ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id   uuid NOT NULL REFERENCES auth.users(id),
  student_id   uuid NOT NULL REFERENCES auth.users(id),
  topic        text,           -- NULL = use weakspot mining
  per_student  int  NOT NULL DEFAULT 5,
  status       text NOT NULL DEFAULT 'queued',
                                -- 'queued' | 'generating' | 'ready' | 'completed' | 'failed'
  questions    jsonb,           -- populated when status reaches 'ready'
  created_at   timestamptz NOT NULL DEFAULT now(),
  picked_up_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT practice_assignments_status_ck
    CHECK (status IN ('queued', 'generating', 'ready', 'completed', 'failed')),
  CONSTRAINT practice_assignments_per_student_ck
    CHECK (per_student BETWEEN 1 AND 20)
);

CREATE INDEX IF NOT EXISTS practice_assignments_student_idx
  ON practice_assignments (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS practice_assignments_class_idx
  ON practice_assignments (class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS practice_assignments_pending_idx
  ON practice_assignments (student_id, status)
  WHERE status IN ('queued', 'generating');

ALTER TABLE practice_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY practice_assignments_student_read
  ON practice_assignments
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY practice_assignments_student_update
  ON practice_assignments
  FOR UPDATE USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

CREATE POLICY practice_assignments_teacher_read
  ON practice_assignments
  FOR SELECT USING (teacher_id = auth.uid());

COMMENT ON TABLE practice_assignments IS
  'Per-student adaptive-practice queue ticket. The student client picks up queued tickets on next sign-in and runs the existing /api/student/adaptive-practice generator under the student RLS context — this preserves the personal weakspot mining that makes adaptive practice work.';
