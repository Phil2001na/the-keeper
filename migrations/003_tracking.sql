-- 003_tracking — continuity & life-tracking release
-- (applied to the live project as migration keeper_003_tracking)

-- Rolling conversation digest: the agent's same-day working memory.
-- One row per kind ('rolling'); covered_until is the context-window anchor —
-- everything after it rides in context verbatim, everything before it is
-- distilled into content (and journaled / archive-searchable).
create table if not exists keeper_digests (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'rolling',
  content text not null default '',
  covered_until timestamptz,
  updated_at timestamptz default now()
);
create unique index if not exists keeper_digests_kind on keeper_digests(kind);
alter table keeper_digests enable row level security;

-- Observations: append-only time-series of life metrics (money, body, work,
-- mood — anything measurable). You can't improve what you don't track.
create table if not exists keeper_observations (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references keeper_domains(id) on delete set null,
  metric text not null,
  value numeric,
  text_value text,
  unit text,
  observed_at timestamptz not null default now(),
  note text,
  source text not null default 'chat',
  created_at timestamptz default now()
);
create index if not exists keeper_observations_metric on keeper_observations(metric, observed_at desc);
alter table keeper_observations enable row level security;

-- Goals: what he's actually aiming at, optionally tied to a metric.
create table if not exists keeper_goals (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references keeper_domains(id) on delete set null,
  title text not null,
  metric text,
  target_value numeric,
  unit text,
  deadline date,
  status text not null default 'active',
  why text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists keeper_goals_status on keeper_goals(status);
alter table keeper_goals enable row level security;

-- Standing rituals: a touchpoint that renews itself after firing.
alter table keeper_touchpoints add column if not exists recurrence text;
