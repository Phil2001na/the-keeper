-- 008_skills — skills registry + state-capture ledger
-- (apply to the live project as migration keeper_008_skills)

-- Skills registry: declarative metadata for capabilities beyond the fixed
-- tool list, starting with state_capture. The agent can list_skills to see
-- what it's capable of and how it's allowed to behave, instead of that
-- living only in a tool description.
create table if not exists keeper_skills (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null,
  trigger_policy text not null default 'explicit_only', -- explicit_only | suggest | automatic
  version int not null default 1,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table keeper_skills enable row level security;

-- State captures: a guided snapshot of how Philip actually is — body,
-- emotion, thoughts, behaviour, context, meaning, need, relationships,
-- identity — kept separate from keeper_facts so the raw, dated texture of a
-- moment survives instead of being flattened into a durable fact.
-- Quick/deep captures are self-reported in the moment, so they default
-- approved; a retrospective extraction from old conversation defaults
-- provisional until reviewed. Never a diagnosis — see state_dimensions.certainty.
create table if not exists keeper_state_captures (
  id uuid primary key default gen_random_uuid(),
  skill_slug text not null default 'state_capture',
  captured_at timestamptz not null default now(),
  period_start timestamptz,
  period_end timestamptz,
  mode text not null default 'quick', -- quick | deep | retrospective
  summary text not null,
  raw_text text,
  confidence text not null default 'medium', -- low | medium | high
  approval_status text not null default 'approved', -- approved | provisional | rejected
  created_at timestamptz default now()
);
create index if not exists keeper_state_captures_captured_at on keeper_state_captures(captured_at desc);
alter table keeper_state_captures enable row level security;

-- One row per reported/inferred dimension of a capture.
create table if not exists keeper_state_dimensions (
  id uuid primary key default gen_random_uuid(),
  state_capture_id uuid not null references keeper_state_captures(id) on delete cascade,
  dimension text not null, -- body | emotion | thoughts | behaviour | context | meaning | need | relationships | identity
  value text not null,
  intensity int, -- optional 1-10
  certainty text not null default 'reported', -- reported | inferred
  evidence_text text
);
create index if not exists keeper_state_dimensions_capture on keeper_state_dimensions(state_capture_id);
alter table keeper_state_dimensions enable row level security;

-- Links a capture to an existing memory entity instead of duplicating it —
-- e.g. a capture that also logged mood as an observation, or that bears on
-- a thread already being watched.
create table if not exists keeper_state_links (
  id uuid primary key default gen_random_uuid(),
  state_capture_id uuid not null references keeper_state_captures(id) on delete cascade,
  entity_type text not null, -- fact | observation | goal | thread | journal
  entity_id uuid not null,
  relationship text not null default 'relates_to' -- supports | updates | conflicts_with | relates_to
);
create index if not exists keeper_state_links_capture on keeper_state_links(state_capture_id);
alter table keeper_state_links enable row level security;

insert into keeper_skills (slug, name, description, trigger_policy)
values (
  'state_capture',
  'State capture',
  'Guided snapshot of how Philip actually is — body, emotion, thoughts, behaviour, context, meaning, need, relationships, identity. Quick check-in (2-4 questions) or deep capture (8-12 questions, consent-gated) held live in conversation, or a retrospective extraction from a past date range. Never diagnoses; always distinguishes what he reported from what was inferred.',
  'explicit_only'
)
on conflict (slug) do nothing;
