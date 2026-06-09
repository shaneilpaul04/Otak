-- ─────────────────────────────────────────────────────────────────────────────
-- OTAK — Supabase schema
-- Run this entire file in your Supabase SQL editor (Dashboard → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- PROFILES — extends auth.users with Otak-specific data
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  uni text,
  year text,
  faculty text,
  module text,
  onboarded_at timestamptz,
  last_essay_at timestamptz,
  total_essays int default 0,
  total_sections_completed int default 0,
  streak_essays int default 0,
  pro_tier boolean default false,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ESSAYS — every analysis session
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.essays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,

  -- content
  original_text text not null,
  rubric_text text,
  rubric_filename text,
  assignment_question text,

  -- context at time of analysis
  selected_lang text default 'en',
  selected_wrote text default 'self',
  subject text,
  word_count int,

  -- analysis results (cached for resume)
  verdict_text text,
  flags jsonb,
  ai_markers jsonb,
  rubric_analysis jsonb,
  context_extracted jsonb,

  -- progress state (for pause/resume)
  state text default 'in_progress',     -- in_progress | completed | abandoned
  completed_sections jsonb default '[]'::jsonb,
  skipped_sections jsonb default '[]'::jsonb,
  quick_picks_used int default 0,
  pushbacks_received int default 0,

  -- final
  final_essay text,
  total_word_delta int default 0,
  authenticity_score int,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);

create index essays_user_id_idx on public.essays(user_id);
create index essays_state_idx on public.essays(state);
create index essays_created_at_idx on public.essays(created_at desc);

alter table public.essays enable row level security;

create policy "Users can read own essays"
  on public.essays for select using (auth.uid() = user_id);
create policy "Users can insert own essays"
  on public.essays for insert with check (auth.uid() = user_id);
create policy "Users can update own essays"
  on public.essays for update using (auth.uid() = user_id);
create policy "Users can delete own essays"
  on public.essays for delete using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- WEAKNESS PATTERNS — tracked across essays per user
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.weakness_patterns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  tag text not null,
  count int default 1,
  first_seen timestamptz default now(),
  last_seen timestamptz default now(),
  last_essay_id uuid references public.essays(id) on delete set null,
  unique (user_id, tag)
);

create index weakness_patterns_user_idx on public.weakness_patterns(user_id);

alter table public.weakness_patterns enable row level security;

create policy "Users can read own weaknesses"
  on public.weakness_patterns for select using (auth.uid() = user_id);
create policy "Users can insert own weaknesses"
  on public.weakness_patterns for insert with check (auth.uid() = user_id);
create policy "Users can update own weaknesses"
  on public.weakness_patterns for update using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- USAGE LOG — for rate limiting and analytics
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  action text not null,
  metadata jsonb,
  created_at timestamptz default now()
);

create index usage_log_user_created on public.usage_log(user_id, created_at desc);

alter table public.usage_log enable row level security;
create policy "Users can read own usage"
  on public.usage_log for select using (auth.uid() = user_id);
create policy "Users can insert own usage"
  on public.usage_log for insert with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER — auto-create profile row on signup
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, created_at)
  values (new.id, now())
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC — increment essay stats on profile
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.increment_essay_stats(uid uuid)
returns void as $$
begin
  update public.profiles
  set
    total_essays = total_essays + 1,
    last_essay_at = now()
  where id = uid;
end;
$$ language plpgsql security definer;
