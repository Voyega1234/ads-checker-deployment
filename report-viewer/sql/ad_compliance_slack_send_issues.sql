create table if not exists public.ad_compliance_slack_send_issues (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  account_name text,
  client_name text,
  channel_id text not null,
  slack_ts text not null,
  issue_index integer not null,
  issue_fingerprint text,
  ad_ids text[] not null default '{}',
  modal_blocks jsonb not null,
  private_metadata jsonb not null default '{}',
  report_url text,
  report_generated_at timestamptz,
  meta jsonb,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists ad_compliance_slack_send_issues_message_issue_idx
  on public.ad_compliance_slack_send_issues (channel_id, slack_ts, issue_index);

create index if not exists ad_compliance_slack_send_issues_account_idx
  on public.ad_compliance_slack_send_issues (account_id);

create index if not exists ad_compliance_slack_send_issues_fingerprint_idx
  on public.ad_compliance_slack_send_issues (issue_fingerprint);

create index if not exists ad_compliance_slack_send_issues_sent_at_idx
  on public.ad_compliance_slack_send_issues (sent_at desc);
