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
