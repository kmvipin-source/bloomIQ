-- BloomIQ: Topic-family classification for progress comparison.
-- Each quiz gets a canonical, LLM-assigned topic family so progress can roll
-- up across "Apple anatomy" + "Apple varieties" + "Apples in nutrition" etc.

alter table public.quizzes
  add column if not exists topic_family text;

create index if not exists quizzes_topic_family_idx on public.quizzes (topic_family);
create index if not exists quizzes_owner_topic_family_idx on public.quizzes (owner_id, topic_family);
