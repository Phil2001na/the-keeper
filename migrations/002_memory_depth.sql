-- THE KEEPER — schema v2: memory depth
-- Adds (1) full-text search over the entire conversation archive,
--      (2) the agent's private nightly journal,
--      (3) outcome tracking on touchpoints so the agent learns which
--          reach-outs actually land.
-- All changes are additive — safe to run on a live database.

-- ─── Full-text search over keeper_interactions ─────────────────────
-- The agent's conversational memory used to be the last N messages only.
-- This makes EVERYTHING he ever said searchable (search_history tool).
alter table keeper_interactions
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists keeper_interactions_fts
  on keeper_interactions using gin(fts);

-- ─── keeper_journal ────────────────────────────────────────────────
-- One private entry per night (write_journal tool, nightly reflection).
-- The last few entries are folded into the system prompt — the agent's
-- continuity of self between days.
create table if not exists keeper_journal (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'nightly',
  day         text not null,               -- local date, YYYY-MM-DD (config TZ)
  entry       text not null,
  created_at  timestamptz default now()
);
create unique index if not exists keeper_journal_kind_day
  on keeper_journal(kind, day);
alter table keeper_journal enable row level security;

-- ─── Touchpoint outcomes ───────────────────────────────────────────
-- outcome: 'sent' (messaged him) | 'silent' (chose silence) | 'replied'
-- (he answered within a few hours of a sent touchpoint). Reflection reads
-- these stats to learn which check-ins are worth making.
alter table keeper_touchpoints add column if not exists outcome text;
alter table keeper_touchpoints add column if not exists fired_at timestamptz;
