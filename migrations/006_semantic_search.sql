-- 006_semantic_search — vector embeddings for keeper_interactions
--
-- Backs semantic recall in search_history: interactions.log fires off an
-- async Gemini text-embedding-004 call and stores the 768-dim vector here.
-- match_interactions() is a Postgres function (not exposed via PostgREST
-- query builder — cosine distance needs an RPC call) that repositories.ts
-- calls via db.rpc('match_interactions', ...).

create extension if not exists vector;

alter table keeper_interactions add column if not exists embedding vector(768);

-- ivfflat needs an estimate of row count to size lists; 100 is a reasonable
-- default for a personal archive (thousands, not millions, of rows). Rebuild
-- with a larger `lists` value if the archive grows past ~100k interactions.
create index if not exists keeper_interactions_embedding_idx
  on keeper_interactions using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function match_interactions(
  query_embedding vector(768),
  match_count int default 12
)
returns table (
  id uuid,
  role text,
  content text,
  trigger text,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    id, role, content, trigger, created_at,
    1 - (embedding <=> query_embedding) as similarity
  from keeper_interactions
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
