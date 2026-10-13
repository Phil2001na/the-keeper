-- 010_lock_in — the LOCK IN protocol: bounded, committed work sessions
-- (apply to the live project as migration keeper_010_lock_in)
--
-- The Keeper's default stance is CALM: space, softness, no nagging. That is
-- the right stance for a hard season and the wrong one for a day that needs
-- output. LOCK IN is a second stance he can enter deliberately: a timed
-- session with named deliverables, timed check-ins, no tolerance for drift,
-- and a score at the end. Everything else about the Keeper — memory, tools,
-- rituals — is unchanged; only its posture moves.
--
-- Nothing here is "always on". A session exists or it doesn't; when none is
-- active the Keeper is in CALM. That is the whole state machine.

create table if not exists keeper_lockin_sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  -- When the session is scheduled to end. The scheduler debriefs at this time
  -- whether or not he says anything — a session that never ends is just a mood.
  ends_at timestamptz not null,
  ended_at timestamptz,
  -- active: running. completed: ran its full time. aborted: ended early.
  status text not null default 'active',
  -- One line on what this session is FOR, in his words.
  intent text,
  check_in_minutes int not null default 30,
  -- Anchor for the check-in rhythm: the last time the Keeper pinged him.
  last_check_in_at timestamptz,
  -- Whether the CURRENT unanswered check-in has already been escalated, so a
  -- single silence gets exactly one harder ping, not an endless ladder.
  escalated boolean not null default false,
  -- How many times he tried to open a tangent mid-session and got refused.
  drift_count int not null default 0,
  -- Honest 0-10 on what actually landed, written at debrief, plus the read.
  score int,
  debrief text,
  created_at timestamptz default now()
);
create index if not exists keeper_lockin_sessions_status on keeper_lockin_sessions(status, ends_at);
alter table keeper_lockin_sessions enable row level security;

-- The commitment. A session cannot start without at least one of these, and
-- the debrief scores against exactly these — not against whatever he happened
-- to do instead. This is what makes the session falsifiable.
create table if not exists keeper_lockin_targets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references keeper_lockin_sessions(id) on delete cascade,
  position int not null,
  title text not null,
  -- committed → landed | partial | missed (set at debrief, or live as he goes)
  status text not null default 'committed',
  note text,
  created_at timestamptz default now()
);
create unique index if not exists keeper_lockin_targets_pos on keeper_lockin_targets(session_id, position);
alter table keeper_lockin_targets enable row level security;

-- The texture of the session: every ping, every refusal, every progress note.
-- Kept so the debrief can be specific ("you lost 40 minutes to the Roblox
-- thing at 14:20") instead of vague, and so patterns show up across sessions.
create table if not exists keeper_lockin_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references keeper_lockin_sessions(id) on delete cascade,
  at timestamptz not null default now(),
  -- check_in | escalation | drift | progress | note
  kind text not null,
  detail text not null
);
create index if not exists keeper_lockin_events_session on keeper_lockin_events(session_id, at);
alter table keeper_lockin_events enable row level security;

insert into keeper_skills (slug, name, description, trigger_policy)
values (
  'lock_in',
  'Lock in protocol',
  'A bounded work session Philip enters on purpose. He names 1-3 concrete deliverables and a duration; the Keeper switches from its CALM stance to LOCK IN — blunt, short, no softening — checks in on a timer, refuses to help with tangents that are not the committed targets, and at the end scores what actually landed and logs it so the trend is visible across sessions. Only Philip starts a session; the Keeper may suggest one but never enters it unasked.',
  'explicit_only'
)
on conflict (slug) do nothing;
