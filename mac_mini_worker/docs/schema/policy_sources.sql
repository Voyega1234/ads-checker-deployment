create table public.policy_sources (
  id uuid not null default gen_random_uuid (),
  policy_type text not null,
  src text not null,
  source_title text null,
  source_language text not null default 'unknown'::text,
  source_category text not null default 'other'::text,
  source_metadata_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint policy_sources_pkey primary key (id),
  constraint policy_sources_src_key unique (src),
  constraint policy_sources_policy_type_check check (
    (
      policy_type = any (array['thai_law'::text, 'meta_policy'::text])
    )
  ),
  constraint policy_sources_source_category_check check (
    (
      source_category = any (
        array[
          'law'::text,
          'announcement'::text,
          'guideline'::text,
          'manual'::text,
          'policy_page'::text,
          'help_page'::text,
          'other'::text
        ]
      )
    )
  ),
  constraint policy_sources_source_language_check check (
    (
      source_language = any (
        array[
          'th'::text,
          'en'::text,
          'bilingual'::text,
          'mixed'::text,
          'unknown'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_policy_sources_policy_type on public.policy_sources using btree (policy_type) TABLESPACE pg_default;

create index IF not exists idx_policy_sources_source_category on public.policy_sources using btree (source_category) TABLESPACE pg_default;

create index IF not exists idx_policy_sources_is_active on public.policy_sources using btree (is_active) TABLESPACE pg_default;

create index IF not exists idx_policy_sources_source_metadata_json_gin on public.policy_sources using gin (source_metadata_json) TABLESPACE pg_default;

create trigger trg_policy_sources_updated_at BEFORE
update on policy_sources for EACH row
execute FUNCTION set_updated_at ();