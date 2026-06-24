create table public.policy_rule_embeddings (
  id bigserial not null,
  rule_id uuid not null,
  embedding_model text not null default 'text-embedding-3-small'::text,
  embedding_dimension integer not null default 1536,
  retrieval_text text not null,
  retrieval_text_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding public.vector not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint policy_rule_embeddings_pkey primary key (id),
  constraint policy_rule_embeddings_unique_rule_model unique (rule_id, embedding_model),
  constraint policy_rule_embeddings_rule_id_fkey foreign KEY (rule_id) references policy_rules (id) on delete CASCADE,
  constraint policy_rule_embeddings_dimension_check check ((embedding_dimension = 1536)),
  constraint policy_rule_embeddings_hash_not_blank check (
    (
      length(
        TRIM(
          both
          from
            retrieval_text_hash
        )
      ) > 0
    )
  ),
  constraint policy_rule_embeddings_retrieval_text_not_blank check (
    (
      length(
        TRIM(
          both
          from
            retrieval_text
        )
      ) > 0
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_policy_rule_embeddings_rule_id on public.policy_rule_embeddings using btree (rule_id) TABLESPACE pg_default;

create index IF not exists idx_policy_rule_embeddings_model on public.policy_rule_embeddings using btree (embedding_model) TABLESPACE pg_default;

create index IF not exists idx_policy_rule_embeddings_hash on public.policy_rule_embeddings using btree (retrieval_text_hash) TABLESPACE pg_default;

create index IF not exists idx_policy_rule_embeddings_metadata_gin on public.policy_rule_embeddings using gin (metadata) TABLESPACE pg_default;

create index IF not exists idx_policy_rule_embeddings_embedding_hnsw on public.policy_rule_embeddings using hnsw (embedding vector_cosine_ops)
with
  (m = '32', ef_construction = '256') TABLESPACE pg_default;

create trigger trg_policy_rule_embeddings_updated_at BEFORE
update on policy_rule_embeddings for EACH row
execute FUNCTION set_policy_rule_embeddings_updated_at ();