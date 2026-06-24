create table public.client_policy_rule_ignores (
  client_id text not null,
  rule_id uuid not null,
  is_ignored boolean not null default true,
  last_updated_by_slack_id text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint client_policy_rule_ignores_pkey primary key (client_id, rule_id),
  constraint client_policy_rule_ignores_rule_id_fkey foreign KEY (rule_id) references policy_rules (id) on update CASCADE on delete CASCADE,
  constraint client_policy_rule_ignores_client_id_not_blank check (
    (
      length(
        TRIM(
          both
          from
            client_id
        )
      ) > 0
    )
  ),
  constraint client_policy_rule_ignores_last_updated_by_slack_id_not_blank check (
    (
      (last_updated_by_slack_id is null)
      or (
        length(
          TRIM(
            both
            from
              last_updated_by_slack_id
          )
        ) > 0
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_client_policy_rule_ignores_rule_id on public.client_policy_rule_ignores using btree (rule_id) TABLESPACE pg_default;

create index IF not exists idx_client_policy_rule_ignores_is_ignored on public.client_policy_rule_ignores using btree (is_ignored) TABLESPACE pg_default;

create index IF not exists idx_client_policy_rule_ignores_active_by_client on public.client_policy_rule_ignores using btree (client_id, rule_id) TABLESPACE pg_default
where
  (is_ignored = true);