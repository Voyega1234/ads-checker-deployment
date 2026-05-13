create table if not exists public.ad_compliance_slack_sends (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null default 'ad_compliance_alert',
  account_id text,
  account_name text,
  client_name text,
  channel_id text not null,
  slack_ts text,
  report_url text,
  viewer_url text,
  report_generated_at timestamptz,
  sent_at timestamptz not null default now(),
  status text not null default 'sent',
  error text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ad_compliance_slack_sends_account_idx
  on public.ad_compliance_slack_sends (account_id);

create index if not exists ad_compliance_slack_sends_channel_idx
  on public.ad_compliance_slack_sends (channel_id);

create index if not exists ad_compliance_slack_sends_sent_at_idx
  on public.ad_compliance_slack_sends (sent_at desc);

create index if not exists ad_compliance_slack_sends_status_idx
  on public.ad_compliance_slack_sends (status);
