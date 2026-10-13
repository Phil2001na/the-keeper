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
 * State is in memory on purpose: a Railway restart drops the queue, and the
 * PC agent then reports its running sessions as orphaned and stops them. A
 * permission request is never auto-approved by a restart.
 *
 *  POST /pc/agent/poll    long-poll: {projects} in → {jobs, decisions, stops} out   (agent)
 *  POST /pc/agent/event   one event from a running session                          (agent)
 *  GET  /pc/state         online?, projects, recent jobs, open approvals           (viewer)
 *  POST /pc/start         {project, task}                                           (viewer)
 *  POST /pc/approve       {id, allow}                                               (viewer)
 *  POST /pc/stop          {jobId}                                                   (viewer)
 */

const AGENT_TOKEN = (process.env.REMOTE_BROWSER_TOKEN ?? '').replace(/\s+/g, '');
const POLL_MS = 25_000;
const ONLINE_MS = 60_000;
const MAX_JOBS = 30;
const MAX_EVENTS = 300;
const APPROVAL_TTL_MS = 30 * 60_000;

export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface JobEvent {
  at: number;
  kind: 'started' | 'text' | 'step' | 'approval' | 'decided' | 'screenshot' | 'done' | 'error';
  text?: string;
  /** Screenshot JPEG as base64 — kept only on the job's latest-shot slot, not in the event log. */
  b64?: string;
}

export interface Job {
  id: string;
  project: string;
  task: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  result?: string;
  costUsd?: number;
  events: JobEvent[];
  shot?: { at: number; b64: string; caption?: string };
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
let waiter: ServerResponse | null = null;
let agentSeen = 0;
let projects: string[] = [];
/** Recent screenshots by `<jobId>-<at>`, so each chat image keeps its own picture. */
const shots = new Map<string, Buffer>();
const MAX_SHOTS = 40;

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
  if (startQueue.length === 0 && decisionQueue.length === 0 && stopQueue.length === 0) return;
  const res = waiter;
  waiter = null;
  const start = startQueue.splice(0).map((id) => jobs.get(id)).filter((j): j is Job => Boolean(j));
  json(res, 200, {
    jobs: start.map((j) => ({ id: j.id, project: j.project, task: j.task })),
    decisions: decisionQueue.splice(0),
    stops: stopQueue.splice(0),
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

export function startJob(project: string, task: string): { ok: true; job: Job } | { ok: false; error: string } {
  if (!AGENT_TOKEN) return { ok: false, error: 'PC bridge is not configured (REMOTE_BROWSER_TOKEN unset).' };
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
  const job: Job = { id: randomUUID().slice(0, 8), project: p, task: clean, status: 'queued', createdAt: now, updatedAt: now, events: [] };
  jobs.set(job.id, job);
  startQueue.push(job.id);
  prune();
  flush();
  return { ok: true, job };
}

export function stopJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || !['queued', 'running', 'waiting'].includes(job.status)) return false;
  if (job.status === 'queued') {
    startQueue = startQueue.filter((id) => id !== jobId);
    job.status = 'stopped';
    push(job, { at: Date.now(), kind: 'error', text: 'Stopped before it started.' });
    return true;
  }
  stopQueue.push(jobId);
  flush();
  return true;
}

/** Answer a pending permission request. Returns false if it's unknown or already answered. */
export function decide(approvalId: string, allow: boolean, note?: string): boolean {
  const a = approvals.get(approvalId);
  if (!a) return false;
  approvals.delete(approvalId);
  decisionQueue.push({ id: approvalId, allow, note });
  const job = jobs.get(a.jobId);
  if (job) {
    if (job.status === 'waiting' && ![...approvals.values()].some((x) => x.jobId === job.id)) job.status = 'running';
    push(job, { at: Date.now(), kind: 'decided', text: `${allow ? 'Approved' : 'Denied'}: ${a.summary}` });
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

/** Compact, screenshot-free view for the web UI and the model. */
export function jobSummary(j: Job) {
  return {
    id: j.id,
    project: j.project,
    task: j.task.slice(0, 300),
    status: j.status,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    result: j.result?.slice(0, 4000),
    costUsd: j.costUsd,
    recent: j.events.slice(-12).map((e) => ({ at: e.at, kind: e.kind, text: e.text?.slice(0, 500) })),
    hasShot: Boolean(j.shot),
  };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

const EVENT_KINDS = new Set(['started', 'text', 'step', 'approval', 'screenshot', 'done', 'error', 'orphaned']);

function onAgentEvent(b: Record<string, unknown>): string | null {
  const job = typeof b.jobId === 'string' ? jobs.get(b.jobId) : undefined;
  const kind = String(b.kind ?? '');
  if (!EVENT_KINDS.has(kind)) return 'bad kind';
  if (!job) return kind === 'orphaned' ? null : 'unknown job';
  const text = typeof b.text === 'string' ? b.text.slice(0, 6000) : undefined;
  const at = Date.now();

  switch (kind) {
    case 'started':
      job.status = 'running';
      if (typeof b.sessionId === 'string') job.sessionId = b.sessionId.slice(0, 80);
      push(job, { at, kind: 'started', text: `Claude started on ${job.project}.` });
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
      if (!id || approvals.has(id)) return 'bad approval id';
      const approval: Approval = {
        id,
        jobId: job.id,
        tool: String(b.tool ?? 'tool').slice(0, 80),
        summary: (text ?? 'wants to use a tool').slice(0, 1500),
        at,
      };
      approvals.set(id, approval);
      job.status = 'waiting';
      push(job, { at, kind: 'approval', text: approval.summary });
      pcEvents.emit('event', { type: 'approval', job, approval } satisfies PcEvent);
      return null;
    }
    case 'done':
      job.status = 'done';
      job.result = text;
      if (typeof b.costUsd === 'number') job.costUsd = b.costUsd;
      for (const [id, a] of approvals) if (a.jobId === job.id) approvals.delete(id);
      push(job, { at, kind: 'done', text });
      return null;
    case 'error':
    case 'orphaned':
      job.status = b.stopped === true ? 'stopped' : 'failed';
      for (const [id, a] of approvals) if (a.jobId === job.id) approvals.delete(id);
      push(job, { at, kind: 'error', text: text ?? 'failed' });
      return null;
  }
  return null;
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
          agentSeen = Date.now();
          if (Array.isArray(b.projects)) {
            projects = b.projects.filter((p): p is string => typeof p === 'string' && p.length < 100).slice(0, 100);
          }
          // Jobs the PC says it's running that we no longer know (Railway restarted):
          // tell it to stop them rather than let them run unwatched.
          if (Array.isArray(b.running)) {
            for (const id of b.running) if (typeof id === 'string' && !jobs.has(id) && !stopQueue.includes(id)) stopQueue.push(id);
          }
          if (waiter) json(waiter, 200, { jobs: [], decisions: [], stops: [] }); // one agent at a time
          waiter = res;
          const t = setTimeout(() => {
            if (waiter === res) {
              waiter = null;
              json(res, 200, { jobs: [], decisions: [], stops: [] });
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
    json(res, 404, { ok: false });
    return true;
  }

  if (!authed) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }
  if (req.method === 'GET' && path === '/pc/state') {
    json(res, 200, { online: pcOnline(), projects, jobs: listJobs().map(jobSummary), approvals: openApprovals() });
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
    void readJson<{ project?: unknown; task?: unknown }>(req, 32 * 1024)
      .then((b) => {
        const r = startJob(String(b.project ?? ''), String(b.task ?? ''));
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true, job: jobSummary(r.job) } : r);
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
