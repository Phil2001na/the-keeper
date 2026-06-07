-- THE KEEPER — schema v1
-- Run this in the Supabase SQL editor (or `psql`) once.

-- ─── keeper_domains ───────────────────────────────────────────
-- Every "sector" of life the agent tracks. New sectors are ROWS, created by
-- the agent at runtime via the create_domain tool — not new tables.
create table if not exists keeper_domains (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,        -- health | social | create | work | general | <dynamic>
  name        text not null,
  description text,                         -- what this sector covers / how to treat it
  cadence_hint text,                        -- agent's note on how often to check in
  priority    int default 3,               -- 1 high .. 5 low
  created_by  text default 'agent',         -- seed | agent | user
  active      boolean default true,
  created_at  timestamptz default now()
);

-- ─── keeper_facts ──────────────────────────────────────
-- Structured things that are true about the user's life right now.
create table if not exists keeper_facts (
  id          uuid primary key default gen_random_uuid(),
  domain_id   uuid references keeper_domains(id) on delete set null,
  key         text not null,
  value       text not null,
  confidence  text default 'medium',        -- low | medium | high
  updated_at  timestamptz default now()
);
-- One value per (domain, key): remember_fact upserts on this.
create unique index if not exists keeper_facts_domain_key
  on keeper_facts(domain_id, key);

-- ─── keeper_touchpoints ───────────────────────────────────────
-- The agent's self-managed schedule of future check-ins. THE HEART OF AUTONOMY.
-- The agent writes rows here; the scheduler only reads them.
create table if not exists keeper_touchpoints (
  id          uuid primary key default gen_random_uuid(),
  fire_at     timestamptz not null,         -- when the agent decided to reach out
  domain_id   uuid references keeper_domains(id) on delete set null,
  reason      text not null,                -- why / what it wants to raise
  status      text default 'pending',       -- pending | fired | cancelled
  created_at  timestamptz default now()
);
create index if not exists touchpoints_due
  on keeper_touchpoints(status, fire_at);

-- ─── keeper_interactions ──────────────────────────────────────
-- Conversation log for continuity and recall.
create table if not exists keeper_interactions (
  id          uuid primary key default gen_random_uuid(),
  role        text not null,                -- user | agent
  content     text not null,
  trigger     text,                         -- inbound | touchpoint:<id>
  created_at  timestamptz default now()
);
create index if not exists interactions_recent
  on keeper_interactions(created_at desc);
