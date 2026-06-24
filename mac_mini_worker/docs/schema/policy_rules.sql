create table public.policy_rules (
  id uuid not null default gen_random_uuid (),
  rule_title text not null,
  rule_text text not null,
  fix_note text null,
  src_id uuid not null,
  src_locator text not null,
  src_display text not null,
  raw_rule_from_src text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint policy_rules_pkey1 primary key (id),
  constraint policy_rules_src_id_fkey foreign KEY (src_id) references policy_sources (id)
) TABLESPACE pg_default;