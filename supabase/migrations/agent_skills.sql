create extension if not exists "pgcrypto";

-- جدول الـ Skills الأساسي
create table if not exists public.agent_skills (
  id            uuid primary key default gen_random_uuid(),
  name          text unique not null,
  display_name  text not null,
  description   text not null,
  version       text not null default '1.0.0',
  category      text,
  tags          text[] default '{}',
  priority      integer default 0,
  is_active     boolean default true,
  required_tools text[] default '{}',
  metadata      jsonb default '{}',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- جدول الموارد المرتبطة بكل Skill
create table if not exists public.skill_resources (
  id           uuid primary key default gen_random_uuid(),
  skill_id     uuid not null references public.agent_skills(id) on delete cascade,
  filename     text not null,
  content      text,
  storage_path text,
  content_type text default 'text/markdown',
  is_primary   boolean default false,
  sort_order   integer default 0,
  created_at   timestamptz default now(),
  
  unique(skill_id, filename)
);

-- جدول سجلات الاستخدام للمراقبة والتحسين
create table if not exists public.skill_usage_logs (
  id              uuid primary key default gen_random_uuid(),
  skill_id        uuid not null references public.agent_skills(id) on delete cascade,
  conversation_id text,
  tokens_used     integer,
  latency_ms      integer,
  success         boolean,
  error_message   text,
  created_at      timestamptz default now()
);

-- Indexes
create index if not exists idx_agent_skills_active on public.agent_skills(is_active) where is_active = true;
create index if not exists idx_agent_skills_tags on public.agent_skills using gin(tags);
create index if not exists idx_agent_skills_category on public.agent_skills(category);
create index if not exists idx_skill_resources_skill_id on public.skill_resources(skill_id);

-- Trigger لتحديث updated_at
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trigger_agent_skills_updated
  before update on public.agent_skills
  for each row execute function public.update_updated_at();
