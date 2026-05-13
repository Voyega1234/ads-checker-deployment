-- IMPORTANT NOTE: This sql file is already executed in the Supabase database.
-- The provided file is for reference only.
-- To help users understand the database schema, we provide the sql file here.

create table public.meta_adaccounts (
  "Account name" text null,
  "Account ID" bigint not null,
  "Status" text null,
  "Client" text null,
  constraint meta_adaccounts_pkey primary key ("Account ID")
) TABLESPACE pg_default;

-- Required for gen_random_uuid() in most PostgreSQL / Supabase projects
create extension if not exists pgcrypto;


-- =========================================================
-- 1) Latest assessment state per Meta ad account
-- =========================================================
-- Purpose:
--   Keep the latest verification state for each Meta ad account.
--   This table is used to know whether an ad account has been
--   assessed before, when it was last assessed, which run produced
--   the latest result, and whether the latest run succeeded or failed.
--
-- Granularity:
--   One row per ad account.
-- =========================================================

create table if not exists public.meta_adaccount_assessment_state (
  ad_account_id bigint primary key,
  -- Raw numeric Meta ad account ID.
  -- References public.meta_adaccounts."Account ID".

  ad_account_act_id text generated always as ('act_' || ad_account_id::text) stored,
  -- Meta API formatted ad account ID, e.g. act_123456789.

  ad_account_name text,
  -- Human-readable ad account name from Meta / source table.

  ad_account_status text,
  -- Current ad account status, e.g. Active / Inactive.

  client_id text,
  -- Client identifier used to match with Google Sheet Client tab for Slack routing.

  last_assessment_at timestamptz,
  -- Latest time this ad account was assessed by the worker.

  assessment_status text,
  -- Latest worker-level status, e.g. Slack Message Dispatched / Error.

  last_run_id uuid,
  -- Latest related verification run ID.

  last_slack_message jsonb,
  -- Latest Slack/report payload stored for quick lookup.
  -- Full historical Slack payload should be stored in meta_ad_check_historical_slack_message.

  last_error text,
  -- Latest error message if the assessment failed.

  created_at timestamptz not null default now(),
  -- Time this state row was first created.

  updated_at timestamptz not null default now(),
  -- Time this state row was last updated.

  constraint meta_adaccount_assessment_state_ad_account_fk
    foreign key (ad_account_id)
    references public.meta_adaccounts ("Account ID")
    on update cascade
    on delete restrict
);


-- =========================================================
-- 2) Current Meta Ad Check DB
-- =========================================================
-- Purpose:
--   Replace the Google Sheet tab "Meta Check DB".
--   This table stores the latest/current assessment state
--   per ad + creative.
--
-- Granularity:
--   One row per client + ad account + ad + creative.
--
-- Primary key:
--   (client_id, ad_account_id, ad_id, creative_id)
-- =========================================================

create table if not exists public.meta_ad_check_db (
  client_id text not null,
  -- Client identifier used for grouping and Slack routing.

  ad_account_id bigint not null,
  -- Raw numeric Meta ad account ID.
  -- References public.meta_adaccounts."Account ID".

  ad_account_act_id text generated always as ('act_' || ad_account_id::text) stored,
  -- Meta API formatted ad account ID, e.g. act_123456789.

  ad_id text not null,
  -- Meta ad ID.

  creative_id text not null,
  -- Meta creative ID.

  ad_text text,
  -- Main ad caption / primary text extracted from the creative.

  ad_media text[],
  -- List of media URLs related to the ad creative.
  -- Example: ARRAY['https://...', 'https://...']

  ad_created_at timestamptz,
  -- Meta ad created_time.

  ad_updated_at timestamptz,
  -- Meta ad updated_time.

  last_checked_at timestamptz,
  -- Latest time this ad row was assessed.

  last_checked_run_id uuid,
  -- Latest run ID that checked this ad row.

  ad_text_check_status text not null default 'not_verified',
  -- Text check status.
  -- Expected values: not_verified | verified | rejected | error

  ad_text_assessment_result jsonb,
  -- Full text assessment result JSON.

  ad_media_check_status text not null default 'not_verified',
  -- Media check status.
  -- Expected values: not_verified | verified | rejected | error

  ad_media_assessment_result jsonb,
  -- Full media/image assessment result JSON.

  row_created_at timestamptz not null default now(),
  -- Time this current-state row was first created.

  row_updated_at timestamptz not null default now(),
  -- Time this current-state row was last updated.

  constraint meta_ad_check_db_pkey
    primary key (client_id, ad_account_id, ad_id, creative_id),

  constraint meta_ad_check_db_ad_account_fk
    foreign key (ad_account_id)
    references public.meta_adaccounts ("Account ID")
    on update cascade
    on delete restrict,

  constraint meta_ad_check_db_text_status_check
    check (ad_text_check_status in ('not_verified', 'verified', 'rejected', 'error')),

  constraint meta_ad_check_db_media_status_check
    check (ad_media_check_status in ('not_verified', 'verified', 'rejected', 'error'))
);


-- =========================================================
-- 3) Historical Meta Ad Check Run Rows
-- =========================================================
-- Purpose:
--   Store historical snapshots of ad check results.
--   This table stores the ad-level result at the time of each run.
--
-- Important:
--   Current flow is 1 run = 1 ad account.
--   However, 1 ad account run can still contain many ads.
--   Therefore, run_id alone should not be the primary key here.
--
-- Granularity:
--   One row per run + ad + creative.
--
-- Slack message:
--   Slack payload is intentionally not stored in this table.
--   It is stored separately in meta_ad_check_historical_slack_message.
-- =========================================================

create table if not exists public.meta_ad_check_historical_run (
  run_id uuid not null,
  -- Verification run ID.
  -- One run represents one ad account verification cycle.
  -- The same run_id can appear in multiple rows because one ad account can contain many ads.

  client_id text not null,
  -- Client identifier used for grouping and Slack routing.

  ad_account_id bigint not null,
  -- Raw numeric Meta ad account ID.
  -- References public.meta_adaccounts."Account ID".

  ad_account_act_id text generated always as ('act_' || ad_account_id::text) stored,
  -- Meta API formatted ad account ID, e.g. act_123456789.

  ad_id text not null,
  -- Meta ad ID.

  creative_id text not null,
  -- Meta creative ID.

  ad_text text,
  -- Main ad caption / primary text at the time of this run.

  ad_media text[],
  -- List of media URLs at the time of this run.

  ad_created_at timestamptz,
  -- Meta ad created_time.

  ad_updated_at timestamptz,
  -- Meta ad updated_time.

  last_checked_at timestamptz,
  -- Time this ad row was checked in this run.

  last_checked_run_id uuid,
  -- Usually the same value as run_id.
  -- Kept for compatibility with the current-state table.

  ad_text_check_status text not null default 'not_verified',
  -- Text check status at the time of this run.
  -- Expected values: not_verified | verified | rejected | error

  ad_text_assessment_result jsonb,
  -- Full text assessment result JSON at the time of this run.

  ad_media_check_status text not null default 'not_verified',
  -- Media check status at the time of this run.
  -- Expected values: not_verified | verified | rejected | error

  ad_media_assessment_result jsonb,
  -- Full media/image assessment result JSON at the time of this run.

  row_created_at timestamptz not null default now(),
  -- Time this historical row was created.

  row_updated_at timestamptz not null default now(),
  -- Time this historical row was last updated.

  constraint meta_ad_check_historical_run_pkey
    primary key (run_id, client_id, ad_account_id, ad_id, creative_id),

  constraint meta_ad_check_historical_run_ad_account_fk
    foreign key (ad_account_id)
    references public.meta_adaccounts ("Account ID")
    on update cascade
    on delete restrict,

  constraint meta_ad_check_historical_run_text_status_check
    check (ad_text_check_status in ('not_verified', 'verified', 'rejected', 'error')),

  constraint meta_ad_check_historical_run_media_status_check
    check (ad_media_check_status in ('not_verified', 'verified', 'rejected', 'error'))
);


-- =========================================================
-- 4) Historical Slack Message per Run
-- =========================================================
-- Purpose:
--   Store the Slack/report payload for each verification run.
--
-- Granularity:
--   One row per run.
--
-- Important:
--   Current flow guarantees 1 run_id = 1 ad account run.
--   Therefore, run_id can be the primary key in this table.
-- =========================================================

create table if not exists public.meta_ad_check_historical_slack_message (
  run_id uuid primary key,
  -- Verification run ID.
  -- One row per run.

  client_id text not null,
  -- Client identifier used for grouping and Slack routing.

  ad_account_id bigint not null,
  -- Raw numeric Meta ad account ID.
  -- References public.meta_adaccounts."Account ID".

  ad_account_act_id text generated always as ('act_' || ad_account_id::text) stored,
  -- Meta API formatted ad account ID, e.g. act_123456789.

  assessed_at timestamptz,
  -- Time this ad account run was assessed.

  slack_message jsonb,
  -- Slack/report payload for this run.
  -- Can store initial message, thread replies, Slack channel, timestamp, or error info.

  created_at timestamptz not null default now(),
  -- Time this Slack history row was created.

  updated_at timestamptz not null default now(),
  -- Time this Slack history row was last updated.

  constraint meta_ad_check_historical_slack_message_ad_account_fk
    foreign key (ad_account_id)
    references public.meta_adaccounts ("Account ID")
    on update cascade
    on delete restrict
);


-- =========================================================
-- Indexes for faster lookup
-- =========================================================

create index if not exists meta_adaccount_assessment_state_client_idx
on public.meta_adaccount_assessment_state (client_id);

create index if not exists meta_adaccount_assessment_state_last_assessment_idx
on public.meta_adaccount_assessment_state (last_assessment_at desc);

create index if not exists meta_adaccount_assessment_state_last_run_idx
on public.meta_adaccount_assessment_state (last_run_id);


create index if not exists meta_ad_check_db_client_idx
on public.meta_ad_check_db (client_id);

create index if not exists meta_ad_check_db_ad_account_idx
on public.meta_ad_check_db (ad_account_id);

create index if not exists meta_ad_check_db_ad_id_idx
on public.meta_ad_check_db (ad_id);

create index if not exists meta_ad_check_db_text_status_idx
on public.meta_ad_check_db (ad_text_check_status);

create index if not exists meta_ad_check_db_media_status_idx
on public.meta_ad_check_db (ad_media_check_status);

create index if not exists meta_ad_check_db_last_checked_idx
on public.meta_ad_check_db (last_checked_at desc);

create index if not exists meta_ad_check_db_last_run_idx
on public.meta_ad_check_db (last_checked_run_id);


create index if not exists meta_ad_check_historical_run_client_idx
on public.meta_ad_check_historical_run (client_id);

create index if not exists meta_ad_check_historical_run_account_idx
on public.meta_ad_check_historical_run (ad_account_id);

create index if not exists meta_ad_check_historical_run_ad_id_idx
on public.meta_ad_check_historical_run (ad_id);

create index if not exists meta_ad_check_historical_run_run_id_idx
on public.meta_ad_check_historical_run (run_id);

create index if not exists meta_ad_check_historical_run_checked_idx
on public.meta_ad_check_historical_run (last_checked_at desc);


create index if not exists meta_ad_check_historical_slack_message_client_idx
on public.meta_ad_check_historical_slack_message (client_id);

create index if not exists meta_ad_check_historical_slack_message_account_idx
on public.meta_ad_check_historical_slack_message (ad_account_id);

create index if not exists meta_ad_check_historical_slack_message_assessed_idx
on public.meta_ad_check_historical_slack_message (assessed_at desc);