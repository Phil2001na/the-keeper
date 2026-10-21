import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * PC bridge: Philip starts a Claude Code session on his PC from his phone.
 *
 * Same shape as the remote browser: the PC never accepts connections. Its
 * agent (pc-agent/agent.mjs) long-polls this relay for work and posts back
 * what the session is doing.
 *
 *   Keeper tool / web  ──enqueue──▶  relay  ◀──long-poll──  PC agent
 *   phone (approve)    ──decide───▶  relay  ──poll reply──▶ PC agent
 *   PC agent  ──POST event──▶  relay  ──pcEvents──▶  Telegram + web bus + chat log
 *
 * The agent authenticates with REMOTE_BROWSER_TOKEN (same PC, same trust as
 * the remote browser). Viewer routes use the normal KEEPER_WEB_TOKEN gate.
 *
 * State is in memory. A Railway restart drops it, so the PC agent names what
 * it is still running (and what is still waiting on him) in every poll and the
 * relay adopts those sessions back, and a finished session's result is retried
 * by the agent until a relay takes it. A permission request is never
 * auto-approved by a restart: it is asked again.
 *
 * Every job ends in a message to him. `sweepPcJobs` is the backstop for the
 * ones the PC never reports on: never picked up, PC went quiet, ran too long.
 *
 *  POST /pc/agent/poll    long-poll: {projects} in → {jobs, decisions, stops} out   (agent)
 *  POST /pc/agent/event   one event from a running session                          (agent)
 *  GET  /pc/state         online?, projects, recent jobs, open approvals           (viewer)
 *  POST /pc/start         {project, task, mode?, engine?}  mode: 'meeseeks' (default) | 'persistent'  (viewer)
 *  POST /pc/send          {jobId, message}        follow-up to an idle persistent session   (viewer)
 *  POST /pc/approve       {id, allow}                                               (viewer)
 *  POST /pc/stop          {jobId}                 ends the session (idle or running)        (viewer)
 *  POST /pc/delegate      {goal, primeId?, engine?}  a goal for a new Meeseeks Prime, or for that idle one (viewer)
 *  POST /pc/agent/crew    {op, parentId, ...}     Prime's crew tools: spawn / status / stop    (agent)
 *
 * The crew. Every job has a role:
 *   solo    a Meeseeks the Keeper (or he) started directly. Reports straight to him.
 *   prime   Meeseeks Prime, the chief of staff. Up to MAX_PRIMES (3) at once, each on
 *           its own goal with its own crew; always persistent, runs on
 *           the engine it was started with (claude | codex); without one,
 *           PRIME_ENGINE/PRIME_MODEL (Codex + gpt-6.1-sol by default).
 *           He hears when each comes online and goes offline. Solo Meeseeks never
 *           count against the Prime limit (and pc-agent/lanes.mjs keeps it that way on the PC).
 *   worker  spawned and named by Prime through pc-agent/crew-mcp.mjs. Reports to
 *           Prime, not to him: he only hears when one dies or fails. When the
 *           last of Prime's workers ends while Prime is idle, Prime is woken
 *           with their results (capped by PRIME_MAX_AUTOWAKE per ask).
 *
 * Two session modes (see SessionMode):
 *   meeseeks    one task, then the session is gone. The original behaviour.
 *   persistent  after each task it goes `idle` and stays resumable on the PC until
 *               he sends a follow-up, ends it, or it sits idle past PC_IDLE_MAX_MIN.
 *               Same approvals, same time cap per task, same outbox delivery.
 */

const AGENT_TOKEN = (process.env.REMOTE_BROWSER_TOKEN ?? '').replace(/\s+/g, '');
const POLL_MS = 25_000;
const ONLINE_MS = 60_000;
const MAX_JOBS = 30;
const MAX_EVENTS = 300;
const APPROVAL_TTL_MS = 30 * 60_000;
const SWEEP_MS = 30_000;
/** A handed-out job the agent neither started nor listed as running is handed out again. */
const REHAND_MS = 20_000;

function minutes(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Queued this long with no PC taking it: the PC is off or asleep. */
const QUEUE_TIMEOUT_MIN = minutes('PC_QUEUE_TIMEOUT_MIN', 10);
/** A persistent session nobody has spoken to in this long is closed (and he is told). */
const IDLE_MAX_MIN = minutes('PC_IDLE_MAX_MIN', 480);
/** A running session the PC has not vouched for in this long is reported as lost. */
const LOST_CONTACT_MIN = minutes('PC_LOST_CONTACT_MIN', 5);
/** Hard cap on one session; past it the relay asks the PC to stop it. */
const MAX_RUN_MIN = minutes('PC_MAX_RUN_MIN', 120);
/** Workers one Prime may have alive at once. */
const MAX_CREW = minutes('PC_MAX_CREW', 3);
/** Meeseeks Primes up at once. Env may lower it, never raise it past 3 (the PC enforces 3 too). */
export const MAX_PRIMES = Math.min(3, Math.floor(minutes('PC_MAX_PRIMES', 3)) || 1);
/** Times Prime is woken by its own crew finishing before he has to speak again. */
const PRIME_MAX_AUTOWAKE = minutes('PRIME_MAX_AUTOWAKE', 6);
const PRIME_ENGINE: Engine = process.env.PRIME_ENGINE === 'claude' ? 'claude' : 'codex';
const PRIME_MODEL = (process.env.PRIME_MODEL ?? 'gpt-6.1-sol').trim() || undefined;
const PRIME_PROJECT = process.env.PRIME_PROJECT ?? 'the-keeper';
export const PRIME_NAME = 'Meeseeks Prime';

// Crew lessons (src/agent/crewLessons.ts owns the store; this module stays
// database-free). Every job and follow-up carries the current list.
let crewLessons: string[] = [];
let recordLesson: (text: string) => void = () => {};
export function setCrewLessons(list: string[], onPrimeLesson?: (text: string) => void): void {
  crewLessons = list.slice(-30);
  if (onPrimeLesson) recordLesson = onPrimeLesson;
}

export type JobStatus = 'queued' | 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped';

/**
 * How long a session lives. The ids are the wire/API values and stay put; only
 * the label below is product wording.
 */
export type SessionMode = 'meeseeks' | 'persistent';
export const SESSION_MODES: SessionMode[] = ['meeseeks', 'persistent'];

// PROVISIONAL-NAME: Philip wants a Meeseeks-related name for the persistent mode
// but has not chosen one. Change the label here only; nothing else depends on it.
export const MODE_LABELS: Record<SessionMode, string> = {
  meeseeks: 'Meeseeks',
  persistent: 'Meeseeks Prime',
};

/** Which coding agent runs the session on the PC. */
export type Engine = 'claude' | 'codex';
export const ENGINES: Engine[] = ['claude', 'codex'];

export function parseEngine(v: unknown): Engine | null {
  if (v === undefined || v === null || v === '') return 'claude';
  return ENGINES.includes(v as Engine) ? (v as Engine) : null;
}

/** Where a session sits in the crew. See the header. */
export type CrewRole = 'solo' | 'prime' | 'worker';

export interface StartOpts {
  name?: string;
  role?: CrewRole;
  parentId?: string;
  engine?: Engine;
  model?: string;
  /** One line on what it is about, for the crew panel. Defaults to the start of the task. */
  brief?: string;
}

// Solo Meeseeks get a name too, so the joke holds even when Prime is not the one naming.
const SOLO_NAMES = [
  'Mr. Meeseeks', 'Can-Do Meeseeks', 'Look-At-Me Meeseeks', 'Box-Fresh Meeseeks', 'Existence-Is-Pain Meeseeks',
  'Ooh-Wee Meeseeks', 'Tiny Meeseeks', 'Pickle Meeseeks', 'Squanchy Meeseeks', 'Plumbus Meeseeks',
];
let soloCounter = 0;

function briefOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 140 ? line.slice(0, 137) + '…' : line;
}

const LIVE: JobStatus[] = ['queued', 'running', 'waiting', 'idle'];
const isLive = (j: Job): boolean => LIVE.includes(j.status);

/** A live name is never reused: a second one gets "II", "III"… */
function uniqueName(want: string): string {
  const base = want.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Mr. Meeseeks';
  const taken = new Set([...jobs.values()].filter(isLive).map((j) => j.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const roman = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  for (const r of roman) if (!taken.has(`${base} ${r}`.toLowerCase())) return `${base} ${r}`;
  return `${base} ${randomUUID().slice(0, 4)}`;
}

export function parseMode(v: unknown): SessionMode | null {
  if (v === undefined || v === null || v === '') return 'meeseeks';
  return SESSION_MODES.includes(v as SessionMode) ? (v as SessionMode) : null;
}

export interface JobEvent {
  at: number;
  kind: 'started' | 'text' | 'step' | 'approval' | 'decided' | 'screenshot' | 'done' | 'turn_done' | 'error';
  text?: string;
  /** Screenshot JPEG as base64 — kept only on the job's latest-shot slot, not in the event log. */
  b64?: string;
}

export interface Job {
  id: string;
  project: string;
  task: string;
  mode: SessionMode;
  /** Its crew name ("Meeseeks Prime", or whatever Prime called it). */
  name: string;
  role: CrewRole;
  /** Workers: the Prime that spawned it. */
  parentId?: string;
  engine: Engine;
  model?: string;
  /** One line on what it is about. */
  brief: string;
  /** Workers: its ending has been handed to Prime (in a wake-up or a status read). */
  reportedToParent?: boolean;
  /** Prime: wake-ups by its own crew since he last spoke to it. */
  autoWakes?: number;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  result?: string;
  costUsd?: number;
  events: JobEvent[];
  shot?: { at: number; b64: string; caption?: string };
  /** When it was last handed to the agent in a poll reply (unset = still to hand out). */
  handedAt?: number;
  /** Last time the PC vouched for it: an event from it, or listing it as running. */
  seenAt: number;
  /** Why the relay asked for a stop, so the stop is reported truthfully. */
  stopReason?: 'timeout';
  /** What it was doing when the relay asked for that stop. */
  stopContext?: string;
  /** Persistent: when the current task began (the first one = createdAt). The per-task time cap counts from here. */
  turnStartedAt?: number;
  /** Persistent: tasks finished so far. */
  turns?: number;
  /** Persistent: a follow-up waiting to be handed to the PC. */
  followup?: { text: string; handedAt?: number };
  /** Reported as failed because the PC went quiet; it may still come back. */
  lost?: boolean;
  /** When a stop for it last went out to the PC, so a stop lost in transit is sent again. */
  stopSentAt?: number;
}

export interface Approval {
  id: string;
  jobId: string;
  tool: string;
  summary: string;
  at: number;
}

/** What other modules (Telegram, push, chat log) react to. */
export type PcEvent =
  | { type: 'job'; job: Job; event: JobEvent }
  | { type: 'approval'; job: Job; approval: Approval }
  | { type: 'approval_closed'; approvalId: string; allow: boolean };

export const pcEvents = new EventEmitter();

const jobs = new Map<string, Job>();
const approvals = new Map<string, Approval>();
let startQueue: string[] = [];
let decisionQueue: { id: string; allow: boolean; note?: string }[] = [];
let stopQueue: string[] = [];
let followQueue: string[] = [];
let waiter: ServerResponse | null = null;
let agentSeen = 0;
let projects: string[] = [];
/** Recent screenshots by `<jobId>-<at>`, so each chat image keeps its own picture. */
const shots = new Map<string, Buffer>();
const MAX_SHOTS = 40;
/** Event ids already applied: the agent retries until it gets a 200, so a lost reply must not double-post. */
const seenEids = new Set<string>();
/**
 * Approvals already answered, so a poll that still lists one does not ask him
 * twice. The answer is kept: if the poll reply carrying it went to a dead socket
 * (PC asleep), the PC keeps listing the approval and gets the answer again.
 */
const decided = new Map<string, { allow: boolean; note?: string; sentAt?: number }>();

function remember(set: Set<string>, id: string, max: number): void {
  set.add(id);
  trim(set, max);
}

function trim(c: Set<string> | Map<string, unknown>, max: number): void {
  while (c.size > max) c.delete(c.keys().next().value!);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function agentAuthed(req: IncomingMessage): boolean {
  if (!AGENT_TOKEN) return false;
  const got = Buffer.from(String(req.headers['x-agent-token'] ?? ''));
  const want = Buffer.from(AGENT_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson<T>(req: IncomingMessage, max: number): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
}

function flush(): void {
  if (!waiter) return;
  if (startQueue.length === 0 && decisionQueue.length === 0 && stopQueue.length === 0 && followQueue.length === 0) return;
  const res = waiter;
  waiter = null;
  const start = startQueue.splice(0).map((id) => jobs.get(id)).filter((j): j is Job => Boolean(j));
  // Not forgotten once written: the socket may be dead (PC asleep). notePoll
  // hands a job out again until the agent starts it or lists it as running.
  for (const j of start) j.handedAt = Date.now();
  const follow = followQueue.splice(0).map((id) => jobs.get(id)).filter((j): j is Job => Boolean(j?.followup));
  for (const j of follow) j.followup!.handedAt = Date.now();
  // Answers and stops can be lost the same way; notePoll sends them again while the PC still shows it never got them.
  const answers = decisionQueue.splice(0);
  for (const d of answers) {
    const x = decided.get(d.id);
    if (x) x.sentAt = Date.now();
  }
  const stops = stopQueue.splice(0);
  for (const id of stops) {
    const j = jobs.get(id);
    if (j) j.stopSentAt = Date.now();
  }
  json(res, 200, {
    jobs: start.map((j) => ({ id: j.id, project: j.project, task: j.task, mode: j.mode, name: j.name, role: j.role, parentId: j.parentId, engine: j.engine, model: j.model, lessons: crewLessons })),
    followups: follow.map((j) => ({ id: j.id, message: j.followup!.text, lessons: crewLessons })),
    decisions: answers,
    stops,
  });
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  const old = [...jobs.values()]
    .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'stopped')
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const j of old.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

function push(job: Job, event: JobEvent): void {
  job.updatedAt = event.at;
  job.events.push(event);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  pcEvents.emit('event', { type: 'job', job, event } satisfies PcEvent);
  // Crew bookkeeping runs after everyone has seen this event, so his "Prime
  // finished" message is never overtaken by the wake-up it triggers.
  if (job.role === 'worker' && (event.kind === 'done' || event.kind === 'error')) {
    queueMicrotask(() => maybeWakePrime(job.parentId));
  } else if (job.role === 'prime' && event.kind === 'turn_done') {
    queueMicrotask(() => maybeWakePrime(job.id));
  } else if (job.role === 'prime' && event.kind === 'error' && !job.lost) {
    // Prime is gone for good: its crew does not keep running unwatched.
    queueMicrotask(() => {
      for (const w of crewOf(job.id)) if (isLive(w)) stopJob(w.id);
    });
  }
}

// ─── API for the rest of Keeper ─────────────────────────────────────────────

export function pcOnline(): boolean {
  return Date.now() - agentSeen < ONLINE_MS;
}

export function pcProjects(): string[] {
  return [...projects];
}

/** Resolve a loose project name ("solarize", "Solarize ") to one the PC reported. */
export function matchProject(name: string): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const exact = projects.find((p) => p.toLowerCase() === want);
  if (exact) return exact;
  const partial = projects.filter((p) => p.toLowerCase().includes(want));
  return partial.length === 1 ? partial[0]! : null;
}

/** The Meeseeks Primes that are up (queued, working, waiting on him, or idle), oldest first. */
export function livePrimes(): Job[] {
  return [...jobs.values()].filter((j) => j.role === 'prime' && isLive(j)).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Who holds a Prime slot. A Prime lost with the PC still holds one: it comes
 * back when the PC does, and a fourth must not have taken its place by then.
 * Stopping it (stopJob) gives the slot back.
 */
function primeSlotHolders(): Job[] {
  return [...jobs.values()].filter((j) => j.role === 'prime' && (isLive(j) || (j.status === 'failed' && j.lost)));
}

export function primeSlots(): { used: number; limit: number; free: number } {
  const used = primeSlotHolders().length;
  return { used, limit: MAX_PRIMES, free: Math.max(0, MAX_PRIMES - used) };
}

/** One line per Prime holding a slot, for a refusal he (or the Keeper) can act on. */
function primeRoster(): string {
  return primeSlotHolders()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => `${p.name} (${p.id}, ${p.lost ? 'lost contact' : p.status}) on: ${p.brief}`)
    .join('; ');
}

/** Workers Prime spawned, newest first. */
export function crewOf(parentId: string): Job[] {
  return listJobs().filter((j) => j.role === 'worker' && j.parentId === parentId);
}

export function startJob(
  project: string,
  task: string,
  mode: SessionMode = 'meeseeks',
  opts: StartOpts = {}
): { ok: true; job: Job } | { ok: false; error: string } {
  const role: CrewRole = opts.role ?? 'solo';
  if (role === 'prime') mode = 'persistent';
  if (!SESSION_MODES.includes(mode)) return { ok: false, error: `Unknown session mode "${String(mode)}". Use one of: ${SESSION_MODES.join(', ')}.` };
  const engine: Engine = opts.engine ?? (role === 'prime' ? PRIME_ENGINE : 'claude');
  if (!ENGINES.includes(engine)) return { ok: false, error: `Unknown engine "${String(engine)}". Use one of: ${ENGINES.join(', ')}.` };
  if (!AGENT_TOKEN) return { ok: false, error: 'PC bridge is not configured (REMOTE_BROWSER_TOKEN unset).' };
  // Checked and claimed in this one synchronous call (the job is in `jobs` before
  // it returns), so two starts can never both see the last free slot.
  if (role === 'prime' && primeSlots().free === 0) {
    return { ok: false, error: `All ${MAX_PRIMES} Meeseeks Primes are already up: ${primeRoster()}. Give this goal to an idle one, wait for one to finish, or stop one first.` };
  }
  let parent: Job | undefined;
  if (role === 'worker') {
    parent = opts.parentId ? jobs.get(opts.parentId) : undefined;
    if (!parent || parent.role !== 'prime' || !isLive(parent)) return { ok: false, error: 'Only a live Meeseeks Prime can spawn workers.' };
    const alive = crewOf(parent.id).filter(isLive).length;
    if (alive >= MAX_CREW) return { ok: false, error: `${alive} workers are already alive (limit ${MAX_CREW}). Wait for one to finish or stop one.` };
  }
  const p = matchProject(project);
  if (!p) {
    return {
      ok: false,
      error: projects.length
        ? `No single project matches "${project}". The PC allows: ${projects.join(', ')}.`
        : 'The PC has not reported any projects yet — is the PC agent running?',
    };
  }
  const clean = task.trim().slice(0, 8000);
  if (!clean) return { ok: false, error: 'Empty task.' };
  const now = Date.now();
  const name =
    uniqueName(role === 'prime' ? PRIME_NAME : opts.name?.trim() || SOLO_NAMES[soloCounter++ % SOLO_NAMES.length]!);
  const model = (opts.model ?? (role === 'prime' && engine === PRIME_ENGINE ? PRIME_MODEL : undefined))?.trim().slice(0, 60) || undefined;
  const job: Job = {
    id: randomUUID().slice(0, 8),
    project: p,
    task: clean,
    mode,
    name,
    role,
    parentId: parent?.id,
    engine,
    model,
    brief: briefOf(opts.brief?.trim() || clean),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    seenAt: now,
    events: [],
  };
  jobs.set(job.id, job);
  startQueue.push(job.id);
  prune();
  flush();
  return { ok: true, job };
}

export function stopJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (job?.status === 'failed' && job.lost) {
    // Lost with the PC: let it go here (a lost Prime gives back its slot), and
    // stop it on the PC if it turns up again.
    job.lost = false;
    job.status = 'stopped';
    if (!stopQueue.includes(job.id)) stopQueue.push(job.id);
    push(job, { at: Date.now(), kind: 'step', text: 'let go after losing contact; if the PC comes back with it, it will be stopped' });
    flush();
    return true;
  }
  if (!job || !['queued', 'running', 'waiting', 'idle'].includes(job.status)) return false;
  if (job.status === 'queued') {
    startQueue = startQueue.filter((id) => id !== jobId);
    job.status = 'stopped';
    push(job, { at: Date.now(), kind: 'error', text: 'Stopped before it started.' });
    return true;
  }
  if (job.status === 'idle') {
    // Nothing is running: close it here so he hears it ended, and tell the PC to forget it.
    closeIdle(job, 'stopped', 'Session closed. Nothing was running; the persistent session is over.');
    return true;
  }
  stopQueue.push(jobId);
  flush();
  return true;
}

function closeIdle(job: Job, status: 'stopped' | 'failed', text: string, now = Date.now()): void {
  job.status = status;
  job.followup = undefined;
  followQueue = followQueue.filter((id) => id !== job.id);
  if (!stopQueue.includes(job.id)) stopQueue.push(job.id);
  push(job, { at: now, kind: 'error', text });
  flush();
}

/**
 * Give an idle persistent session its next task. Only an `idle` one accepts it:
 * a running session is busy, and a Meeseeks is gone after its one task.
 */
export function sendToJob(
  jobId: string,
  message: string,
  from: 'philip' | 'crew' = 'philip'
): { ok: true; job: Job } | { ok: false; error: string } {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: `No single session matches "${jobId}".` };
  if (job.mode !== 'persistent') return { ok: false, error: `Session ${job.id} is a ${MODE_LABELS[job.mode]}: it ends after its one task. Start a new session instead.` };
  if (job.status !== 'idle') {
    const busy = job.status === 'running' || job.status === 'waiting' || job.status === 'queued';
    return { ok: false, error: busy ? `Session ${job.id} is still working (${job.status}); wait for it to finish its current task.` : `Session ${job.id} has already ended (${job.status}).` };
  }
  const clean = message.trim().slice(0, 8000);
  if (!clean) return { ok: false, error: 'Empty message.' };
  const now = Date.now();
  job.status = 'running';
  job.task = clean;
  // A wake-up from its own crew is not a new ask: the brief stays what he wanted.
  if (from === 'philip') {
    job.brief = briefOf(clean);
    job.autoWakes = 0;
  }
  job.turnStartedAt = now;
  job.seenAt = now;
  job.result = undefined;
  job.shot = undefined;
  job.stopReason = undefined;
  job.stopContext = undefined;
  job.followup = { text: clean };
  followQueue.push(job.id);
  push(job, { at: now, kind: 'step', text: from === 'crew' ? 'woken by its crew finishing' : `follow-up sent: ${clean.slice(0, 200)}` });
  flush();
  return { ok: true, job };
}

/**
 * Hand a goal to Meeseeks Prime. With `primeId`, that Prime takes it as its next
 * ask (it must be idle; it keeps its context). Without, a new Prime starts on it
 * while there is a free slot; once all MAX_PRIMES are up he is told who is on
 * what. A busy Prime is never interrupted.
 */
export function delegateToPrime(
  goal: string,
  primeId?: string,
  engine?: Engine
): { ok: true; job: Job; started: boolean } | { ok: false; error: string } {
  if (engine !== undefined && !ENGINES.includes(engine)) return { ok: false, error: `Unknown engine "${String(engine)}". Use one of: ${ENGINES.join(', ')}.` };
  const want = primeId?.trim();
  if (want) {
    const p = getJob(want);
    if (!p || p.role !== 'prime') return { ok: false, error: `No single ${PRIME_NAME} matches "${want}". Up now: ${primeRoster() || 'none'}.` };
    if (!isLive(p)) return { ok: false, error: `${p.name} (${p.id}) has already ended (${jobPhase(p)}). Leave the id out to start a new Prime.` };
    // A running session cannot change engine: its context lives in that engine.
    if (engine && engine !== p.engine) return { ok: false, error: `${p.name} (${p.id}) runs on ${p.engine}, not ${engine}. Leave the id out to start a new Prime on ${engine}.` };
    if (p.status !== 'idle') return { ok: false, error: `${p.name} (${p.id}) is busy (${p.status}) on: ${p.brief}. Wait for its report, or stop it first.` };
    const r = sendToJob(p.id, goal);
    return r.ok ? { ...r, started: false } : r;
  }
  const r = startJob(PRIME_PROJECT, goal, 'persistent', { role: 'prime', engine });
  return r.ok ? { ...r, started: true } : r;
}

// ─── The crew (Prime's tools, via pc-agent/crew-mcp.mjs) ───────────────────

const ENDED: JobStatus[] = ['done', 'failed', 'stopped'];

/** What Prime sees about one worker. The result is its full report. */
function crewView(w: Job) {
  return {
    id: w.id,
    name: w.name,
    engine: w.engine,
    project: w.project,
    brief: w.brief,
    status: w.status,
    phase: jobPhase(w),
    lastStep: lastStep(w).replace(/^ Last thing it reported: /, '') || undefined,
    report: ENDED.includes(w.status) ? (w.status === 'done' ? w.result : [...w.events].reverse().find((e) => e.kind === 'error')?.text) : undefined,
  };
}

export function crewStatus(parentId: string) {
  const crew = crewOf(parentId);
  for (const w of crew) if (ENDED.includes(w.status)) w.reportedToParent = true;
  return { workers: crew.slice(0, 12).map(crewView), limit: MAX_CREW };
}

export function crewStop(parentId: string, workerId: string): boolean {
  const w = jobs.get(workerId);
  return Boolean(w && w.role === 'worker' && w.parentId === parentId && stopJob(w.id));
}

/**
 * A worker ended. If that was the last live one and Prime is idle, wake Prime
 * with the results so the loop closes without Prime blocking on a wait. A busy
 * Prime picks them up when it goes idle (see onAgentEvent turn_done).
 */
function maybeWakePrime(parentId: string | undefined): void {
  const prime = parentId ? jobs.get(parentId) : undefined;
  if (!prime || prime.role !== 'prime' || prime.status !== 'idle') return;
  const crew = crewOf(prime.id);
  if (crew.some(isLive)) return;
  const fresh = crew.filter((w) => ENDED.includes(w.status) && !w.reportedToParent);
  if (!fresh.length) return;
  if ((prime.autoWakes ?? 0) >= PRIME_MAX_AUTOWAKE) {
    push(prime, { at: Date.now(), kind: 'step', text: `crew finished, but it has woken itself ${PRIME_MAX_AUTOWAKE} times since he last spoke, so it waits for him` });
    return;
  }
  for (const w of fresh) w.reportedToParent = true;
  prime.autoWakes = (prime.autoWakes ?? 0) + 1;
  const lines = fresh.map((w) => {
    const v = crewView(w);
    return `## ${w.name} (${w.id}, ${w.engine}) — ${v.phase}\n${(v.report ?? '(no report)').slice(0, 6000)}`;
  });
  sendToJob(
    prime.id,
    `[Your crew has finished. This is not from Philip.]\n\n${lines.join('\n\n')}\n\n` +
      'Judge these against the goal. Spawn more workers if something is still open; otherwise write your report for Philip.',
    'crew'
  );
}

/** Answer a pending permission request. Returns false if it's unknown or already answered. */
export function decide(approvalId: string, allow: boolean, note?: string): boolean {
  const a = approvals.get(approvalId);
  if (!a) return false;
  approvals.delete(approvalId);
  decided.set(approvalId, { allow, note });
  trim(decided, 300);
  decisionQueue.push({ id: approvalId, allow, note });
  const job = jobs.get(a.jobId);
  if (job) {
    if (job.status === 'waiting' && ![...approvals.values()].some((x) => x.jobId === job.id)) job.status = 'running';
    const verdict = note === 'expired' ? 'No answer in 30 minutes, treated as denied' : allow ? 'Approved' : 'Denied';
    push(job, { at: Date.now(), kind: 'decided', text: `${verdict}: ${a.summary}` });
  }
  pcEvents.emit('event', { type: 'approval_closed', approvalId, allow } satisfies PcEvent);
  flush();
  return true;
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getJob(idPrefix: string): Job | null {
  const hits = [...jobs.values()].filter((j) => j.id.startsWith(idPrefix.trim()));
  return hits.length === 1 ? hits[0]! : null;
}

export function openApprovals(): Approval[] {
  const now = Date.now();
  for (const [id, a] of approvals) if (now - a.at > APPROVAL_TTL_MS) decide(id, false, 'expired');
  return [...approvals.values()];
}

function lastStep(job: Job): string {
  const e = [...job.events].reverse().find((x) => x.kind === 'step' || x.kind === 'text');
  return e?.text ? ` Last thing it reported: ${e.text.slice(0, 300)}` : '';
}

function dropApprovals(jobId: string): void {
  for (const [id, a] of approvals) if (a.jobId === jobId) approvals.delete(id);
}

/**
 * The backstop that makes "he always hears how it ended" true even when the PC
 * says nothing: a job nobody picked up, a session whose PC went quiet, one that
 * ran past the cap, an approval nobody answered. Runs on a timer; `now` is a
 * parameter so the rules can be tested without waiting.
 */
export function sweepPcJobs(now = Date.now()): void {
  for (const [id, a] of approvals) if (now - a.at > APPROVAL_TTL_MS) decide(id, false, 'expired');

  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      if (now - job.createdAt < QUEUE_TIMEOUT_MIN * 60_000) continue;
      startQueue = startQueue.filter((id) => id !== job.id);
      job.status = 'failed';
      push(job, {
        at: now,
        kind: 'error',
        text: `The PC never picked this up in ${QUEUE_TIMEOUT_MIN} minutes, so it is off, asleep, or the PC agent is not running. Nothing was done. Ask again once the PC is on.`,
      });
      continue;
    }
    if (job.status === 'idle') {
      if (now - job.seenAt > LOST_CONTACT_MIN * 60_000) {
        job.status = 'failed';
        job.lost = true;
        push(job, { at: now, kind: 'error', text: `Lost contact with the PC ${LOST_CONTACT_MIN} minutes ago, so this persistent session may be gone. If the PC comes back with it, it will reopen here.` });
      } else if (now - job.updatedAt > IDLE_MAX_MIN * 60_000) {
        closeIdle(job, 'stopped', `Session closed after ${IDLE_MAX_MIN} minutes with no new task. Start a new one to continue.`, now);
      }
      continue;
    }
    if (job.status !== 'running' && job.status !== 'waiting') continue;

    if (now - job.seenAt > LOST_CONTACT_MIN * 60_000) {
      job.status = 'failed';
      job.lost = true;
      dropApprovals(job.id);
      push(job, {
        at: now,
        kind: 'error',
        text: `Lost contact with the PC ${LOST_CONTACT_MIN} minutes ago (it went offline, to sleep, or the PC agent stopped), so this may not have finished.${lastStep(job)} If the PC comes back with a result, it will be posted here.`,
      });
      continue;
    }
    if (!job.stopReason && now - (job.turnStartedAt ?? job.createdAt) > MAX_RUN_MIN * 60_000) {
      job.stopReason = 'timeout';
      job.stopContext = lastStep(job);
      if (!stopQueue.includes(job.id)) stopQueue.push(job.id);
      push(job, { at: now, kind: 'step', text: `past the ${MAX_RUN_MIN}-minute limit, stopping it` });
      flush();
    }
  }
}

setInterval(() => sweepPcJobs(), SWEEP_MS).unref();

/**
 * Whether a report should reach him through the Keeper (which says what matters
 * in plain words) instead of verbatim. Prime's reports always do; a solo
 * Meeseeks' only when it is long. Workers report to Prime, never to him.
 */
export const RELAY_OVER_CHARS = 1200;
export function relaysThroughKeeper(job: Job, text: string | undefined): boolean {
  return job.role === 'prime' || (job.role === 'solo' && (text ?? '').length > RELAY_OVER_CHARS);
}

/** What the phone shows for a job. Finer than `status`: it tells apart the endings that all read "failed". */
export type JobPhase = 'queued' | 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'timed_out' | 'not_picked_up' | 'lost' | 'stopped';

/** The note pc-agent appends to a summary when the finish screenshot could not be taken. */
const NO_SHOT_NOTE = /\s*\(No screenshot with this one:[^)]*\)\s*$/;

export function jobPhase(j: Job): JobPhase {
  if (j.status === 'stopped') return j.stopReason === 'timeout' ? 'timed_out' : 'stopped';
  if (j.status === 'failed') {
    if (j.lost) return 'lost';
    // Failed without ever starting: the sweep gave up waiting for the PC.
    if (!j.sessionId && !j.events.some((e) => e.kind === 'started')) return 'not_picked_up';
  }
  return j.status;
}

/** Compact, screenshot-free view for the web UI and the model. */
export function jobSummary(j: Job) {
  const shotMissing = (j.status === 'done' || j.status === 'idle') && !j.shot && NO_SHOT_NOTE.test(j.result ?? '');
  return {
    id: j.id,
    project: j.project,
    task: j.task.slice(0, 300),
    mode: j.mode,
    modeLabel: j.role === 'prime' ? PRIME_NAME : MODE_LABELS[j.mode],
    name: j.name,
    role: j.role,
    parentId: j.parentId,
    engine: j.engine,
    model: j.model,
    brief: j.brief,
    /** Prime is "online" while it is up (working, waiting on him, or idle between asks). */
    online: isLive(j),
    turns: j.turns ?? 0,
    status: j.status,
    phase: jobPhase(j),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    result: (shotMissing ? j.result!.replace(NO_SHOT_NOTE, '') : j.result)?.slice(0, 4000),
    costUsd: j.costUsd,
    recent: j.events.slice(-12).map((e) => ({ at: e.at, kind: e.kind, text: e.text?.slice(0, 500) })),
    hasShot: Boolean(j.shot),
    shotUrl: j.shot ? `/pc/shot/${j.id}-${j.shot.at}` : undefined,
    shotCaption: j.shot?.caption,
    /** The PC could not capture its screen at the end (usually locked or display off). */
    shotMissing,
  };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

const EVENT_KINDS = new Set(['started', 'text', 'step', 'approval', 'screenshot', 'done', 'turn_done', 'error', 'orphaned']);

const JOB_ID = /^[a-z0-9-]{4,40}$/i;

/**
 * Take back a session this relay has no record of (it restarted mid-session).
 * Only ever from the authenticated agent, and only with the project and task it
 * was given, so the result can still be reported under the right name.
 */
function adopt(r: Record<string, unknown>, id: string, now: number): Job | undefined {
  if (!JOB_ID.test(id) || typeof r.project !== 'string' || !r.project || r.project.length >= 100) return undefined;
  const task = typeof r.task === 'string' ? r.task.slice(0, 8000) : '(task not known: the Keeper restarted while this was running)';
  const role: CrewRole = r.role === 'prime' || r.role === 'worker' ? r.role : 'solo';
  const job: Job = {
    id,
    project: r.project,
    task,
    mode: r.mode === 'persistent' || role === 'prime' ? 'persistent' : 'meeseeks',
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : role === 'prime' ? PRIME_NAME : 'Mr. Meeseeks',
    role,
    parentId: role === 'worker' && typeof r.parentId === 'string' ? r.parentId.slice(0, 40) : undefined,
    engine: r.engine === 'codex' ? 'codex' : 'claude',
    model: typeof r.model === 'string' ? r.model.slice(0, 60) : undefined,
    brief: briefOf(typeof r.brief === 'string' ? r.brief : task),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    seenAt: now,
    events: [],
  };
  jobs.set(id, job);
  prune();
  return job;
}

function registerApproval(job: Job, id: string, tool: unknown, summary: string | undefined, at: number): void {
  const approval: Approval = {
    id,
    jobId: job.id,
    tool: String(tool ?? 'tool').slice(0, 80),
    summary: (summary ?? 'wants to use a tool').slice(0, 1500),
    at,
  };
  approvals.set(id, approval);
  job.status = 'waiting';
  push(job, { at, kind: 'approval', text: approval.summary });
  pcEvents.emit('event', { type: 'approval', job, approval } satisfies PcEvent);
}

/** One poll from the agent: who it is, what it allows, what it is running. */
export function notePoll(b: { projects?: unknown; running?: unknown; idle?: unknown }, now = Date.now()): void {
  agentSeen = now;
  if (Array.isArray(b.projects)) {
    projects = b.projects.filter((p): p is string => typeof p === 'string' && p.length < 100).slice(0, 100);
  }
  const listed = new Set<string>();
  for (const r of Array.isArray(b.running) ? b.running : []) {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    const id = typeof r === 'string' ? r : typeof o?.id === 'string' ? o.id : '';
    if (!id) continue;
    listed.add(id);
    let job = jobs.get(id);
    if (!job && o) {
      job = adopt(o, id, now);
      if (job) push(job, { at: now, kind: 'step', text: 'reconnected to a session that was already running (the Keeper restarted)' });
    }
    if (!job) {
      // An agent that only sends ids cannot be adopted: stop it rather than let it run unwatched.
      if (!stopQueue.includes(id)) stopQueue.push(id);
      continue;
    }
    job.seenAt = now;
    job.followup = undefined; // the PC has it: it is running
    // Still running after a stop went out: that reply was lost, ask again.
    if (job.stopSentAt && now - job.stopSentAt >= REHAND_MS && !stopQueue.includes(id)) {
      job.stopSentAt = undefined;
      stopQueue.push(id);
    }
    if (job.status === 'queued') job.status = 'running';
    if (job.lost) {
      job.lost = false;
      job.status = 'running';
      push(job, { at: now, kind: 'text', text: 'The PC is back and this session is still running.' });
    }
    for (const a of Array.isArray(o?.approvals) ? (o.approvals as unknown[]) : []) {
      const x = a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
      const aid = typeof x?.approvalId === 'string' ? x.approvalId.slice(0, 64) : '';
      if (!aid || approvals.has(aid)) continue;
      const d = decided.get(aid);
      if (d) {
        // Answered, but the PC is still waiting: the answer went to a dead socket.
        if (d.sentAt && now - d.sentAt >= REHAND_MS && !decisionQueue.some((q) => q.id === aid)) {
          d.sentAt = undefined;
          decisionQueue.push({ id: aid, allow: d.allow, note: d.note });
        }
        continue;
      }
      registerApproval(job, aid, x?.tool, typeof x?.text === 'string' ? x.text : undefined, now);
    }
  }
  // Persistent sessions the PC is holding open between tasks.
  for (const r of Array.isArray(b.idle) ? b.idle : []) {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    const id = typeof o?.id === 'string' ? o.id : '';
    if (!o || !id || listed.has(id)) continue;
    let job = jobs.get(id);
    if (!job) {
      job = adopt({ ...o, mode: 'persistent' }, id, now);
      if (!job) continue;
      job.status = 'idle';
      push(job, { at: now, kind: 'step', text: 'reconnected to a persistent session that was waiting for its next task (the Keeper restarted)' });
      continue;
    }
    if (job.status === 'done' || job.status === 'stopped' || (job.status === 'failed' && !job.lost)) {
      // Ended on this side (closed, or reported failed): do not leave it open on the PC.
      if (!stopQueue.includes(id)) stopQueue.push(id);
      continue;
    }
    job.seenAt = now;
    if (job.lost) {
      job.lost = false;
      job.status = 'idle';
      push(job, { at: now, kind: 'text', text: 'The PC is back and this persistent session is waiting for its next task.' });
    }
  }
  // A follow-up handed out that the PC neither started nor listed as running: the reply went to a dead socket.
  for (const job of jobs.values()) {
    const f = job.followup;
    if (!f?.handedAt || listed.has(job.id) || job.status !== 'running') continue;
    if (now - f.handedAt < REHAND_MS) continue;
    f.handedAt = undefined;
    if (!followQueue.includes(job.id)) followQueue.push(job.id);
  }
  // Handed out but never started and not listed: the reply went to a dead socket.
  for (const job of jobs.values()) {
    if (job.status !== 'queued' || !job.handedAt || listed.has(job.id)) continue;
    if (now - job.handedAt < REHAND_MS || startQueue.includes(job.id)) continue;
    job.handedAt = undefined;
    startQueue.push(job.id);
  }
}

export function onAgentEvent(b: Record<string, unknown>): string | null {
  const kind = String(b.kind ?? '');
  if (!EVENT_KINDS.has(kind)) return 'bad kind';
  const eid = typeof b.eid === 'string' ? b.eid.slice(0, 64) : '';
  if (eid && seenEids.has(eid)) return null;
  const at = Date.now();
  let job = typeof b.jobId === 'string' ? jobs.get(b.jobId) : undefined;
  // A result for a session this relay forgot (it restarted) is still his result.
  if (!job && typeof b.jobId === 'string' && (kind === 'done' || kind === 'turn_done' || kind === 'error')) job = adopt(b, b.jobId, at);
  if (!job) return kind === 'orphaned' ? null : 'unknown job';
  const text = typeof b.text === 'string' ? b.text.slice(0, 6000) : undefined;
  if (eid) remember(seenEids, eid, 500);
  job.seenAt = at;
  job.lost = false;
  job.followup = undefined;

  switch (kind) {
    case 'started':
      job.status = 'running';
      if (typeof b.sessionId === 'string') job.sessionId = b.sessionId.slice(0, 80);
      push(job, { at, kind: 'started', text: `${job.name} started on ${job.project} (${job.engine}${job.model ? ` · ${job.model}` : ''}).` });
      return null;
    case 'text':
    case 'step':
      if (text) push(job, { at, kind, text });
      return null;
    case 'screenshot': {
      const b64 = typeof b.b64 === 'string' && b.b64.length < 4_000_000 ? b.b64 : null;
      if (!b64) return 'bad screenshot';
      job.shot = { at, b64, caption: text };
      shots.set(`${job.id}-${at}`, Buffer.from(b64, 'base64'));
      while (shots.size > MAX_SHOTS) shots.delete(shots.keys().next().value!);
      push(job, { at, kind: 'screenshot', text: text ?? 'screenshot' });
      return null;
    }
    case 'approval': {
      const id = typeof b.approvalId === 'string' ? b.approvalId.slice(0, 64) : '';
      if (!id) return 'bad approval id';
      if (approvals.has(id) || decided.has(id)) return null; // a poll already re-registered it
      registerApproval(job, id, b.tool, text, at);
      return null;
    }
    case 'turn_done':
      // A persistent session finished one task and stays open for the next. Its
      // result is delivered exactly like a Meeseeks' ending (same outbox, same dedupe).
      if (job.status !== 'stopped' && job.status !== 'done') job.status = 'idle';
      job.mode = 'persistent';
      job.turns = (job.turns ?? 0) + 1;
      job.result = text;
      if (typeof b.sessionId === 'string') job.sessionId = b.sessionId.slice(0, 80);
      if (typeof b.costUsd === 'number') job.costUsd = (job.costUsd ?? 0) + b.costUsd;
      dropApprovals(job.id);
      push(job, { at, kind: 'turn_done', text });
      return null;
    case 'done':
      job.status = 'done';
      job.result = text;
      if (typeof b.costUsd === 'number') job.costUsd = b.costUsd;
      dropApprovals(job.id);
      push(job, { at, kind: 'done', text });
      return null;
    case 'error':
    case 'orphaned':
      job.status = b.stopped === true ? 'stopped' : 'failed';
      dropApprovals(job.id);
      push(job, {
        at,
        kind: 'error',
        text:
          b.stopped === true && job.stopReason === 'timeout'
            ? `It ran past the ${MAX_RUN_MIN}-minute limit and was stopped unfinished.${job.stopContext ?? ''}`
            : text ?? 'failed',
      });
      return null;
  }
  return null;
}

/**
 * Prime's crew tools, called by pc-agent/crew-mcp.mjs on the PC with the agent
 * token. Every op names the Prime it acts for, and only a live Prime may act.
 */
export function crewOp(b: Record<string, unknown>): Record<string, unknown> {
  const parentId = typeof b.parentId === 'string' ? b.parentId : '';
  const prime = jobs.get(parentId);
  if (!prime || prime.role !== 'prime' || !isLive(prime)) return { ok: false, error: 'Only a live Meeseeks Prime can use the crew.' };
  switch (b.op) {
    case 'spawn': {
      const engine = parseEngine(b.engine);
      if (!engine) return { ok: false, error: `engine must be one of: ${ENGINES.join(', ')}` };
      const r = startJob(String(b.project ?? '') || prime.project, String(b.goal ?? ''), 'meeseeks', {
        role: 'worker',
        parentId,
        name: typeof b.name === 'string' ? b.name : undefined,
        engine,
        model: typeof b.model === 'string' && b.model.trim() ? b.model : undefined,
        brief: typeof b.brief === 'string' ? b.brief : undefined,
      });
      return r.ok ? { ok: true, worker: { id: r.job.id, name: r.job.name, engine: r.job.engine, project: r.job.project } } : r;
    }
    case 'status':
      return { ok: true, ...crewStatus(parentId) };
    case 'stop':
      return { ok: crewStop(parentId, String(b.workerId ?? '')) };
    case 'lesson': {
      const text = String(b.lesson ?? '').trim();
      if (!text) return { ok: false, error: 'empty lesson' };
      recordLesson(text.slice(0, 300));
      return { ok: true, note: 'Saved. Every agent started from now on will read it.' };
    }
    default:
      return { ok: false, error: 'op must be spawn, status, stop or lesson' };
  }
}

/** Returns true if it handled the request. `authed` = the normal web token check. */
export function handlePcBridge(req: IncomingMessage, res: ServerResponse, path: string, authed: boolean): boolean {
  if (!path.startsWith('/pc/')) return false;

  if (path.startsWith('/pc/agent/')) {
    if (!agentAuthed(req)) {
      json(res, 401, { ok: false });
      return true;
    }
    if (req.method === 'POST' && path === '/pc/agent/poll') {
      void readJson<{ projects?: unknown; running?: unknown }>(req, 64 * 1024)
        .then((b) => {
          notePoll(b);
          if (waiter) json(waiter, 200, { jobs: [], followups: [], decisions: [], stops: [] }); // one agent at a time
          waiter = res;
          const t = setTimeout(() => {
            if (waiter === res) {
              waiter = null;
              json(res, 200, { jobs: [], followups: [], decisions: [], stops: [] });
            }
          }, POLL_MS);
          res.on('close', () => {
            clearTimeout(t);
            if (waiter === res) waiter = null;
          });
          flush();
        })
        .catch(() => json(res, 400, { ok: false }));
      return true;
    }
    if (req.method === 'POST' && path === '/pc/agent/event') {
      void readJson<Record<string, unknown>>(req, 5 * 1024 * 1024)
        .then((b) => {
          agentSeen = Date.now();
          const err = onAgentEvent(b);
          json(res, err ? 400 : 200, err ? { ok: false, error: err } : { ok: true });
        })
        .catch(() => json(res, 400, { ok: false }));
      return true;
    }
    if (req.method === 'POST' && path === '/pc/agent/crew') {
      void readJson<Record<string, unknown>>(req, 64 * 1024)
        .then((b) => json(res, 200, crewOp(b)))
        .catch(() => json(res, 400, { ok: false, error: 'bad request' }));
      return true;
    }
    json(res, 404, { ok: false });
    return true;
  }

  if (!authed) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }
  if (req.method === 'GET' && path === '/pc/state') {
    json(res, 200, {
      online: pcOnline(),
      lastSeenAt: agentSeen || null,
      limits: { queueMin: QUEUE_TIMEOUT_MIN, lostContactMin: LOST_CONTACT_MIN, maxRunMin: MAX_RUN_MIN },
      primes: primeSlots(),
      modes: SESSION_MODES.map((id) => ({ id, label: MODE_LABELS[id] })),
      projects,
      jobs: listJobs().map(jobSummary),
      approvals: openApprovals(),
    });
    return true;
  }
  if (req.method === 'GET' && path.startsWith('/pc/shot/')) {
    const buf = shots.get(path.slice('/pc/shot/'.length));
    if (!buf) {
      json(res, 404, { ok: false });
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
    res.end(buf);
    return true;
  }
  if (req.method === 'POST' && path === '/pc/start') {
    void readJson<{ project?: unknown; task?: unknown; mode?: unknown; engine?: unknown }>(req, 32 * 1024)
      .then((b) => {
        const mode = parseMode(b.mode);
        if (!mode) return json(res, 400, { ok: false, error: `Unknown mode. Use one of: ${SESSION_MODES.join(', ')}.` });
        const engine = parseEngine(b.engine);
        if (!engine) return json(res, 400, { ok: false, error: `Unknown engine. Use one of: ${ENGINES.join(', ')}.` });
        const r = startJob(String(b.project ?? ''), String(b.task ?? ''), mode, { engine });
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true, job: jobSummary(r.job) } : r);
      })
      .catch(() => json(res, 400, { ok: false }));
    return true;
  }
  if (req.method === 'POST' && path === '/pc/send') {
    void readJson<{ jobId?: unknown; message?: unknown }>(req, 32 * 1024)
      .then((b) => {
        const r = sendToJob(String(b.jobId ?? ''), String(b.message ?? ''));
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true, job: jobSummary(r.job) } : r);
      })
      .catch(() => json(res, 400, { ok: false }));
    return true;
  }
  if (req.method === 'POST' && path === '/pc/delegate') {
    void readJson<{ goal?: unknown; primeId?: unknown; engine?: unknown }>(req, 32 * 1024)
      .then((b) => {
        // No engine sent: Prime's own default (PRIME_ENGINE), not parseEngine's 'claude'.
        const engine = b.engine === undefined || b.engine === null || b.engine === '' ? undefined : parseEngine(b.engine);
        if (engine === null) return json(res, 400, { ok: false, error: `Unknown engine. Use one of: ${ENGINES.join(', ')}.` });
        const r = delegateToPrime(String(b.goal ?? ''), typeof b.primeId === 'string' ? b.primeId : undefined, engine);
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true, started: r.started, job: jobSummary(r.job) } : r);
      })
      .catch(() => json(res, 400, { ok: false }));
    return true;
  }
  if (req.method === 'POST' && path === '/pc/approve') {
    void readJson<{ id?: unknown; allow?: unknown }>(req, 4 * 1024)
      .then((b) => {
        const ok = typeof b.id === 'string' && decide(b.id, b.allow === true);
        json(res, ok ? 200 : 404, { ok });
      })
      .catch(() => json(res, 400, { ok: false }));
    return true;
  }
  if (req.method === 'POST' && path === '/pc/stop') {
    void readJson<{ jobId?: unknown }>(req, 4 * 1024)
      .then((b) => json(res, 200, { ok: typeof b.jobId === 'string' && stopJob(b.jobId) }))
      .catch(() => json(res, 400, { ok: false }));
    return true;
  }
  json(res, 404, { ok: false, error: 'not found' });
  return true;
}
