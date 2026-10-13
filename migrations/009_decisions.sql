-- 009_decisions — decision queues: a project's open questions, answered in
-- conversation, exported as an implementation brief.
-- (apply to the live project as migration keeper_009_decisions)

-- A decision set is one batch of pending questions belonging to one project —
-- a UAT round, a design review, a client sign-off. The set carries the repo
-- coordinates so an answered set can be committed back next to the document
-- that raised the questions.
create table if not exists keeper_decision_sets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  project text not null,              -- human name, e.g. 'security-payroll-demo'
  title text not null,
  context text,                       -- what this batch is about, for the agent's framing
  source_ref text,                    -- where the questions came from, e.g. 'uat/2026-08-20/UAT.md'
  repo_owner text,                    -- GitHub owner for export; null = export unavailable
  repo_name text,
  export_path text,                   -- e.g. 'uat/2026-08-20/DECISIONS.md'
  status text not null default 'open', -- open | complete | archived
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table keeper_decision_sets enable row level security;

-- One question. `options` is a jsonb array of {label, detail} the agent reads
-- aloud; `recommendation` is the agent's own steer, kept separate from
-- `answer` so a later reader can tell what Philip decided from what was
-- suggested to him.
--
-- Status matters as much as the answer: some questions are not his to answer.
-- 'needs_client' / 'needs_legal' record that the question was reached,
-- considered and routed onward — an implementer must not treat those as open
-- and must not invent a rule for them.
create table if not exists keeper_decisions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references keeper_decision_sets(id) on delete cascade,
  ref text not null,                  -- stable id from the source doc, e.g. 'UAT-01'
  area text,
  question text not null,
  context text,                       -- background the agent should read out before asking
  options jsonb not null default '[]'::jsonb,
  recommendation text,
  priority text not null default 'medium', -- critical | high | medium | low
  status text not null default 'open',     -- open | answered | deferred | needs_client | needs_legal
  answer text,
  rationale text,
  blocked_by text,                    -- ref of a decision that must land first
  sort_order int not null default 0,
  decided_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (set_id, ref)
);
create index if not exists keeper_decisions_set_status on keeper_decisions(set_id, status);
alter table keeper_decisions enable row level security;

insert into keeper_skills (slug, name, description, trigger_policy)
values (
  'decision_queue',
  'Decision queue',
  'A project''s open decisions, held as a queue and worked through in conversation one at a time — read the context, offer the options, give a recommendation, record what Philip decided and why. Questions that are the client''s or a lawyer''s to answer are marked as such rather than answered. When the set is done, export it as a committed implementation brief so a coding agent can pick it up without Philip present.',
  'suggest'
)
on conflict (slug) do nothing;
