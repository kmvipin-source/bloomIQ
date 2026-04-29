-- BloomIQ migration 18: Empirical difficulty + discrimination on question_bank.
-- Idempotent.
alter table public.question_bank
  add column if not exists calibrated_difficulty real,
  add column if not exists calibrated_discrimination real,
  add column if not exists calibrated_attempts int,
  add column if not exists calibrated_at timestamptz;

create index if not exists question_bank_calibrated_at_idx
  on public.question_bank (calibrated_at desc);
