-- 1) ENUM: source ของงาน
create type public.macmini_worker_job_source as enum (
  'slack_alert',
  'google_sheet'
);

-- 2) ENUM: status ของงาน
create type public.macmini_worker_job_status as enum (
  'pending',
  'running',
  'success',
  'error',
  'aborted'
);

-- 3) Table
create table public.macmini_worker_jobs (
  run_id uuid primary key default gen_random_uuid(),

  job_source public.macmini_worker_job_source not null,

  input_json jsonb not null default '{}'::jsonb,
  output_json jsonb null,

  status public.macmini_worker_job_status not null default 'pending',

  error_text text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  started_at timestamptz null,
  finished_at timestamptz null
);

-- 4) updated_at auto-update function
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 5) trigger
create trigger set_macmini_worker_jobs_updated_at
before update on public.macmini_worker_jobs
for each row
execute function public.set_updated_at();

-- 6) index สำหรับ worker polling
create index idx_macmini_worker_jobs_status_created_at
on public.macmini_worker_jobs (status, created_at);

create index idx_macmini_worker_jobs_job_source
on public.macmini_worker_jobs (job_source);