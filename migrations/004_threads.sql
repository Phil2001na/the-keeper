-- 004_threads — anticipation: the "watching" ledger
-- (applied to the live project as migration keeper_004_threads)

-- Threads: open loops and forward-looking hypotheses about him — the structured
-- successor to the free-text "Watching:" lists at the bottom of the journals.
-- Each is something the keeper is keeping an eye on; reviewed every reflection
-- and either closed or escalated into a touchpoint. This is how the agent
-- anticipates instead of merely recalling.
create table if not exists keeper_threads (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references keeper_domains(id) on delete set null,
  title text not null,
  note text,
  status text not null default 'open',   -- open | closed
  next_check date,                        -- local date to look at this again (optional)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists keeper_threads_status on keeper_threads(status, next_check);
alter table keeper_threads enable row level security;
