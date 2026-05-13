create table if not exists public.ad_compliance_issue_states (
  report_id text not null,
  issue_key text not null,
  resolved boolean not null default false,
  resolved_by text,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (report_id, issue_key)
);

alter table public.ad_compliance_issue_states enable row level security;

create index if not exists ad_compliance_issue_states_report_id_idx
  on public.ad_compliance_issue_states (report_id);

alter table public.ad_compliance_issue_states
  add column if not exists issue_fingerprint text,
  add column if not exists account_id text,
  add column if not exists issue_type text;

create index if not exists ad_compliance_issue_states_fingerprint_idx
  on public.ad_compliance_issue_states (issue_fingerprint);

create table if not exists public.ad_compliance_issue_resolutions (
  issue_fingerprint text primary key,
  account_id text,
  issue_type text,
  issue_key text,
  resolved boolean not null default false,
  resolved_by text,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.ad_compliance_issue_resolutions enable row level security;

create index if not exists ad_compliance_issue_resolutions_account_id_idx
  on public.ad_compliance_issue_resolutions (account_id);
