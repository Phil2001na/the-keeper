-- 009_decisions — decision queue: sets, decisions, history, exported briefs
-- (apply to the live project as migration keeper_009_decisions)
--
-- HISTORY: keeper_decision_sets and keeper_decisions were created directly
-- against the live project on 24 Aug 2026 — seeded with the security-payroll
-- UAT set and its 21 questions — but no migration file, repository code, or
-- tool was ever written. The agent's daily 18:30 ritual has been telling it to
-- "call list_decision_sets" since 25 Aug against a tool that did not exist.
-- The two create-table statements below reproduce that live shape exactly so
-- the repo is the source of truth again; they are no-ops on the live project.
-- keeper_decision_history and keeper_decision_artifacts are genuinely new.

-- A project's open questions, held as a queue and worked through in
-- conversation one at a time. source_ref / export_path point at the files in
-- the project's own repo: where the questions came from, where the answers go.
create table if not exists keeper_decision_sets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  project text not null,
  title text not null,
  context text,
  source_ref text,          -- e.g. uat/2026-08-20/UAT.md
  repo_owner text,
  repo_name text,
  export_path text,         -- e.g. uat/2026-08-20/DECISIONS.md
  status text not null default 'open', -- open | paused | completed | implemented | closed
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table keeper_decision_sets enable row level security;

-- One question. options is a JSON array of {label, detail}. blocked_by names
-- another decision's ref (not id) — the queue is worked in sort_order, and a
-- blocked question is held back until the one it depends on is settled.
create table if not exists keeper_decisions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references keeper_decision_sets(id) on delete cascade,
  ref text not null,        -- D-01, D-02, ... stable within a set
  area text,
  question text not null,
  context text,
  options jsonb not null default '[]'::jsonb,
  recommendation text,
  priority text not null default 'medium', -- low | medium | high | critical
  status text not null default 'open',
  answer text,
  rationale text,
  blocked_by text,
  sort_order int not null default 0,
  decided_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (set_id, ref)
);
create index if not exists keeper_decisions_set on keeper_decisions(set_id, sort_order);

-- Columns the live tables predate. Additive and idempotent.
-- closure_reason records WHY a set was closed, which matters when it was
-- closed with questions still unresolved.
alter table keeper_decision_sets add column if not exists closed_at timestamptz;
alter table keeper_decision_sets add column if not exists closure_reason text;
-- A question that is the client's or a lawyer's to answer is routed, not
-- guessed — routed_to says whose call it is.
alter table keeper_decisions add column if not exists routed_to text;
alter table keeper_decisions add column if not exists confidence text;

-- Append-only. Every status or answer change lands here BEFORE the row is
-- overwritten, so revising an answer never destroys the reasoning behind the
-- previous one. Nothing deletes from this table.
create table if not exists keeper_decision_history (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references keeper_decisions(id) on delete cascade,
  previous_status text,
  new_status text not null,
  previous_answer text,
  previous_rationale text,
  answer text,
  rationale text,
  changed_by text not null default 'keeper', -- keeper | philip | agent | migration
  note text,
  created_at timestamptz default now()
);
create index if not exists keeper_decision_history_decision
  on keeper_decision_history(decision_id, created_at desc);
alter table keeper_decision_history enable row level security;

-- A rendered brief. Content is stored verbatim so a coding agent reads exactly
-- what was exported, even if a decision is revised afterwards; content_hash
-- makes the export deterministic to compare, and supersedes_id chains versions.
create table if not exists keeper_decision_artifacts (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references keeper_decision_sets(id) on delete cascade,
  artifact_type text not null default 'implementation_brief', -- implementation_brief | uat_summary | verification_report
  content text not null,
  version int not null default 1,
  content_hash text,
  committed_url text,       -- where it was committed, when it was
  created_at timestamptz default now(),
  supersedes_id uuid references keeper_decision_artifacts(id) on delete set null
);
create index if not exists keeper_decision_artifacts_set
  on keeper_decision_artifacts(set_id, version desc);
alter table keeper_decision_artifacts enable row level security;

-- Anything a set is connected to that is not an artifact: the UAT records it
-- came from, a thread being watched, a commit or deployment that implemented
-- it, a verification run. Kept generic rather than one column per kind.
create table if not exists keeper_decision_links (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references keeper_decision_sets(id) on delete cascade,
  decision_id uuid references keeper_decisions(id) on delete cascade,
  link_type text not null, -- uat | thread | file | commit | pr | deployment | verification
  ref text not null,       -- url, path, sha, or entity id
  note text,
  created_at timestamptz default now(),
  unique (set_id, link_type, ref)
);
create index if not exists keeper_decision_links_set on keeper_decision_links(set_id);
alter table keeper_decision_links enable row level security;

-- Recording an answer is two writes (append history, then update the row) and
-- the Supabase JS client has no transaction API, so it runs here instead — one
-- statement, one transaction. Returns the updated decision row.
-- Idempotent by construction: passing the same answer/rationale/status again
-- changes nothing and appends no history, so a retried tool call is safe.
create or replace function keeper_record_decision(
  p_decision_id uuid,
  p_status text,
  p_answer text,
  p_rationale text,
  p_routed_to text default null,
  p_confidence text default null,
  p_changed_by text default 'philip',
  p_note text default null
) returns keeper_decisions
language plpgsql
as $$
declare
  cur keeper_decisions;
  updated keeper_decisions;
begin
  select * into cur from keeper_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'decision % not found', p_decision_id;
  end if;

  -- No-op retry: same status, same answer, same rationale. Return as-is and
  -- do not append a second identical history row.
  if cur.status = p_status
     and cur.answer is not distinct from p_answer
     and cur.rationale is not distinct from p_rationale then
    return cur;
  end if;

  insert into keeper_decision_history (
    decision_id, previous_status, new_status, previous_answer, previous_rationale,
    answer, rationale, changed_by, note
  ) values (
    cur.id, cur.status, p_status, cur.answer, cur.rationale,
    p_answer, p_rationale, p_changed_by, p_note
  );

  update keeper_decisions set
    status      = p_status,
    answer      = coalesce(p_answer, answer),
    rationale   = coalesce(p_rationale, rationale),
    routed_to   = coalesce(p_routed_to, routed_to),
    confidence  = coalesce(p_confidence, confidence),
    decided_at  = case when p_status in ('confirmed', 'routed') then now() else decided_at end,
    updated_at  = now()
  where id = cur.id
  returning * into updated;

  update keeper_decision_sets set updated_at = now() where id = cur.set_id;

  return updated;
end;
$$;

insert into keeper_skills (slug, name, description, trigger_policy)
values (
  'decision_queue',
  'Decision queue',
  'A project''s open decisions, held as a queue and worked through in conversation one at a time — read the context, offer the options, give a recommendation, record what Philip decided and why. Questions that are the client''s or a lawyer''s to answer are marked as such rather than answered. When the set is done, export it as a committed implementation brief so a coding agent can pick it up without Philip present.',
  'suggest'
)
on conflict (slug) do nothing;
