-- BloomIQ: Exam Paper Generator (printable papers, NOT online quizzes)
-- Teachers generate question papers per a custom template, edit, finalize, and print.

create table if not exists public.exam_papers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  school_name text,
  class_grade text,
  subject text,
  exam_date date,
  duration_minutes int default 60,
  total_marks int default 0,
  instructions text,
  status text not null default 'draft' check (status in ('draft','finalized')),
  created_at timestamptz default now()
);
create index if not exists exam_papers_owner_idx on public.exam_papers (owner_id, created_at desc);
alter table public.exam_papers enable row level security;
drop policy if exists "papers owner all" on public.exam_papers;
create policy "papers owner all" on public.exam_papers
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create table if not exists public.exam_paper_questions (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.exam_papers(id) on delete cascade,
  section_name text not null default 'Section A',
  position int not null,
  question_type text not null check (question_type in (
    'mcq','true_false','fill_blank','short_answer','long_answer','numerical'
  )),
  stem text not null,
  options jsonb,
  correct_answer text,
  explanation text,
  marks int not null default 1,
  bloom_level text check (bloom_level in ('remember','understand','apply','analyze','evaluate','create')),
  created_at timestamptz default now()
);
create index if not exists epq_paper_idx on public.exam_paper_questions (paper_id, position);
alter table public.exam_paper_questions enable row level security;
drop policy if exists "epq owner all" on public.exam_paper_questions;
create policy "epq owner all" on public.exam_paper_questions
  for all using (
    exists (select 1 from public.exam_papers p where p.id = paper_id and p.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.exam_papers p where p.id = paper_id and p.owner_id = auth.uid())
  );
