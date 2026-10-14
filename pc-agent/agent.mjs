// Keeper PC agent — runs Claude Code sessions on this PC when Philip asks from his phone.
//
// It only ever calls OUT to the Keeper relay (src/web/pcBridge.ts): long-polls for
// work, posts back what each session is doing. Nothing listens on this machine.
//
//   node agent.mjs            (or: npm start, from this folder)
//
// Config: projects.json next to this file (which folders a session may open, and
// which are "strict"). Token: REMOTE_BROWSER_TOKEN from the Keeper's .env.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = readEnv(join(HERE, '..', '.env'));
const BASE = (process.env.KEEPER_URL || ENV.KEEPER_URL || 'https://the-keeper-production.up.railway.app').replace(/\/$/, '');
const TOKEN = (process.env.REMOTE_BROWSER_TOKEN || ENV.REMOTE_BROWSER_TOKEN || '').replace(/\s+/g, '');
const CONFIG = JSON.parse(readFileSync(process.env.PC_AGENT_CONFIG || join(HERE, 'projects.json'), 'utf-8'));
const MAX_PARALLEL = CONFIG.maxParallel ?? 2;
/** One session may run this long, then it is stopped and reported as unfinished. */
const MAX_MINUTES = CONFIG.maxMinutes ?? 120;
// PC_AGENT_STATE keeps a test run (scripts/pc-harness.ts) out of the live agent's outbox.
const LOG_DIR = process.env.PC_AGENT_STATE || join(HERE, 'logs');
/** How each session ended, kept on disk until the relay has taken it. */
const OUTBOX_DIR = join(LOG_DIR, 'outbox');
/** What is running right now, so a reboot mid-session is reported instead of forgotten. */
const RUNNING_FILE = join(LOG_DIR, 'running.json');
/** Persistent sessions waiting for their next task, so an agent restart does not forget them. */
const IDLE_FILE = join(LOG_DIR, 'idle.json');
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;
mkdirSync(OUTBOX_DIR, { recursive: true });

if (!TOKEN) {
  console.error('REMOTE_BROWSER_TOKEN missing (Keeper .env). Exiting.');
  process.exit(1);
}

/** jobId -> { abort: AbortController, project, task, lastStep, stopReason } */
const running = new Map();
/** Persistent sessions between tasks: jobId -> { project, task, sessionId, mode }. Not counted against MAX_PARALLEL. */
const idle = new Map();
/** approvalId -> { resolve(decision), jobId, tool, text } */
const pendingApprovals = new Map();
/** Jobs that already ended here: the relay hands a job out again if it never saw it start. */
const finished = new Set();

function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { appendFileSync(join(LOG_DIR, 'agent.log'), line + '\n'); } catch { /* best effort */ }
}

/** name -> { path, strict } — explicit entries plus every folder under `root`, minus `exclude`. */
function projects() {
  const out = {};
  const exclude = new Set((CONFIG.exclude ?? []).map((s) => s.toLowerCase()));
  if (CONFIG.root && existsSync(CONFIG.root)) {
    for (const name of readdirSync(CONFIG.root)) {
      if (name.startsWith('.') || name.startsWith('_') || exclude.has(name.toLowerCase())) continue;
      const p = join(CONFIG.root, name);
      try { if (statSync(p).isDirectory()) out[name] = { path: p, strict: false }; } catch { /* skip */ }
    }
  }
  for (const [name, v] of Object.entries(CONFIG.projects ?? {})) out[name] = { path: v.path, strict: Boolean(v.strict) };
  for (const name of CONFIG.strict ?? []) if (out[name]) out[name].strict = true;
  return out;
}

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// Progress events are best effort: a lost step chip costs nothing.
const event = (jobId, kind, extra = {}) =>
  api('/pc/agent/event', { jobId, kind, eid: randomUUID(), ...extra }).catch((e) => log('event failed', kind, e.message));

// How a session ended is not best effort. It is written to disk first and sent
// until the relay takes it, so a redeploy, a dropped connection or this agent
// restarting cannot turn a finished session into silence. `eid` lets the relay
// drop a repeat; project and task let a relay that restarted still name it.
function ending(job, kind, extra = {}) {
  const body = { jobId: job.id, kind, eid: randomUUID(), project: job.project, task: job.task, mode: job.mode ?? 'meeseeks', ...extra };
  try { writeFileSync(join(OUTBOX_DIR, `${Date.now()}-${body.eid}.json`), JSON.stringify(body)); } catch (e) { log('outbox write failed:', e.message); }
  return flushOutbox();
}

let flushing = false;
let flushAgain = false;
const complained = new Set();
async function flushOutbox() {
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    flushAgain = false;
    for (const name of readdirSync(OUTBOX_DIR).filter((n) => n.endsWith('.json')).sort()) {
      const file = join(OUTBOX_DIR, name);
      let body;
      try { body = JSON.parse(readFileSync(file, 'utf-8')); } catch { try { unlinkSync(file); } catch { /* gone */ } continue; }
      try {
        await api('/pc/agent/event', body);
        unlinkSync(file);
        log('delivered', body.kind, body.jobId);
      } catch (e) {
        if (Date.now() - statSync(file).mtimeMs > OUTBOX_MAX_AGE_MS) {
          log('giving up on', body.kind, body.jobId, 'after 24h:', e.message);
          try { unlinkSync(file); } catch { /* gone */ }
        } else if (!complained.has(name)) {
          complained.add(name);
          log('ending not delivered yet, will keep trying:', body.kind, body.jobId, e.message);
        }
      }
    }
  } finally {
    flushing = false;
  }
  if (flushAgain) return flushOutbox();
}

function saveRunning() {
  const list = [...running.entries()].map(([id, r]) => ({ id, project: r.project, task: r.task, mode: r.mode, lastStep: r.lastStep }));
  try { writeFileSync(RUNNING_FILE, JSON.stringify(list)); } catch { /* best effort */ }
}

function saveIdle() {
  const list = [...idle.entries()].map(([id, r]) => ({ id, ...r }));
  try { writeFileSync(IDLE_FILE, JSON.stringify(list)); } catch { /* best effort */ }
}

function restoreIdle() {
  let list = [];
  try { list = JSON.parse(readFileSync(IDLE_FILE, 'utf-8')); } catch { return; }
  for (const j of Array.isArray(list) ? list : []) {
    if (j?.id && j.project && j.sessionId) idle.set(j.id, { project: j.project, task: j.task, sessionId: j.sessionId, mode: 'persistent' });
  }
}

// Sessions that were running when this process last died (reboot, crash, the
// PC lost power) can no longer finish. Say so instead of leaving him waiting.
function reportInterrupted() {
  let list = [];
  try { list = JSON.parse(readFileSync(RUNNING_FILE, 'utf-8')); } catch { return; }
  for (const j of Array.isArray(list) ? list : []) {
    if (!j?.id || !j.project) continue;
    log('interrupted', j.id, j.project);
    void ending(j, 'error', {
      text: `The PC restarted, or the PC agent stopped, while this session was running, so it did not finish.${j.lastStep ? ` Last thing it was doing: ${j.lastStep}.` : ''} Ask again to re-run it.`,
    });
  }
  saveRunning();
}

// ─── What Philip sees on his phone when Claude asks ─────────────────────────

function describe(tool, input) {
  const s = (v, n = 600) => String(v ?? '').slice(0, n);
  switch (tool) {
    case 'Bash': return `Run a command:\n${s(input.command)}${input.description ? `\n(${s(input.description, 200)})` : ''}`;
    case 'Write': return `Create/overwrite a file:\n${s(input.file_path, 300)}`;
    case 'Edit': case 'MultiEdit': return `Edit a file:\n${s(input.file_path, 300)}`;
    case 'WebFetch': return `Fetch a web page:\n${s(input.url, 300)}`;
    default: {
      const pretty = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' → ') : tool;
      return `Use ${pretty}:\n${s(JSON.stringify(input), 700)}`;
    }
  }
}

function stepText(block) {
  const i = block.input ?? {};
  const short = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 140);
  switch (block.name) {
    case 'Bash': return `running: ${short(i.description || i.command)}`;
    case 'Read': return `reading ${short(i.file_path)}`;
    case 'Edit': case 'MultiEdit': case 'Write': return `editing ${short(i.file_path)}`;
    case 'Grep': case 'Glob': return `searching: ${short(i.pattern)}`;
    case 'WebSearch': return `web search: ${short(i.query)}`;
    case 'WebFetch': return `opening ${short(i.url)}`;
    default: return `using ${block.name.startsWith('mcp__') ? block.name.split('__').slice(1).join(' ') : block.name}`;
  }
}

// ─── Screenshots (one at the end of each session) ──────────────────────────

// ffmpeg's gdigrab, not a PowerShell System.Drawing script: Defender's AMSI flags
// the latter as malicious. A locked PC captures as the lock screen — that is
// still the truth about what's on screen.
const FFMPEG = CONFIG.ffmpeg || 'ffmpeg';

function screenshotB64() {
  const out = join(tmpdir(), `keeper-shot-${process.pid}.jpg`);
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-i', 'desktop', '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '5', out],
      { timeout: 20_000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) { log('screenshot failed:', String(stderr || err.message).trim().split('\n').slice(-2).join(' | ').slice(0, 300)); return resolve(null); }
        try { resolve(readFileSync(out).toString('base64')); } catch { resolve(null); }
      }
    );
  });
}

// ─── One session ────────────────────────────────────────────────────────────

const BRIEF = `You were started from Philip's phone through his Keeper. He is NOT at the PC.
- Work autonomously; don't stop to ask questions you can answer with sensible defaults.
- Anything risky (sending messages/emails, deleting data, payments, deploys to production, anything on EDU prod) will be sent to his phone for Approve/Deny — that's fine, just do it the normal way and the approval happens automatically.
- If a website wants a login you don't have, stop and say so clearly in your final message (he can log in through the Keeper's remote browser and re-run you).
- Finish with a short plain-language summary for his phone: what you did, what's left, anything he must do. No jargon, lead with the point.`;

// Only added in the persistent mode. A one-task session never sees it.
const BRIEF_PERSISTENT = `
- This session stays open after you finish a task: he may send a follow-up on the same conversation, so you keep your context. End each task with the summary; do not say the session is over.`;

async function runJob(job) {
  const proj = projects()[job.project];
  if (!proj) return ending(job, 'error', { text: `Project "${job.project}" is not allowed on this PC.` });

  const abort = new AbortController();
  const persistent = job.mode === 'persistent';
  const me = { abort, project: job.project, task: job.task, mode: job.mode ?? 'meeseeks', lastStep: '', stopReason: '' };
  idle.delete(job.id); // a follow-up: it is running again
  saveIdle();
  running.set(job.id, me);
  saveRunning();
  log('start', job.id, job.project, JSON.stringify(job.task.slice(0, 120)));
  const limit = setTimeout(() => {
    me.stopReason = 'timeout';
    abort.abort();
  }, MAX_MINUTES * 60_000);

  const canUseTool = async (toolName, input, { signal }) => {
    const approvalId = randomUUID();
    const text = describe(toolName, input);
    const decision = new Promise((resolve) => {
      // Kept with its wording: every poll lists what is still waiting on him,
      // so a relay that restarted asks again instead of leaving this hanging.
      pendingApprovals.set(approvalId, { resolve, jobId: job.id, tool: toolName, text });
      signal.addEventListener('abort', () => resolve({ allow: false, note: 'aborted' }), { once: true });
    });
    await event(job.id, 'approval', { approvalId, tool: toolName, text });
    const d = await decision;
    pendingApprovals.delete(approvalId);
    log('approval', job.id, toolName, d.allow ? 'ALLOW' : 'DENY');
    return d.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `Philip denied this from his phone${d.note ? ` (${d.note})` : ''}. Don't retry it; find another way or explain in your summary.` };
  };

  let result = '';
  let cost;
  try {
    const q = query({
      prompt: job.task,
      options: {
        cwd: proj.path,
        ...(job.resume ? { resume: job.resume } : {}),
        abortController: abort,
        // strict projects (EDU prod) ask for everything that isn't already allowed;
        // everything else uses auto mode, where only genuinely risky actions ask.
        permissionMode: proj.strict ? 'default' : 'auto',
        canUseTool,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: BRIEF + (persistent ? BRIEF_PERSISTENT : '') },
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        me.sessionId = m.session_id;
        // A resumed turn is the same session: do not announce "started" again.
        if (!job.resume) await event(job.id, 'started', { sessionId: m.session_id });
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) await event(job.id, 'text', { text: b.text.trim().slice(0, 2000) });
          if (b.type === 'tool_use') {
            me.lastStep = stepText(b);
            saveRunning();
            await event(job.id, 'step', { text: me.lastStep });
          }
        }
      } else if (m.type === 'result') {
        result = m.subtype === 'success' ? (m.result ?? '') : `Ended: ${m.subtype}${m.errors?.length ? ` — ${m.errors.join('; ')}` : ''}`;
        cost = m.total_cost_usd;
      }
    }
    // The SDK can end the stream quietly when aborted; that is a stop, not a finish.
    if (abort.signal.aborted) throw new Error('aborted');
    let note = '';
    if (CONFIG.screenshotOnFinish !== false) {
      const shot = await screenshotB64();
      if (shot) await event(job.id, 'screenshot', { b64: shot, text: `${job.project}: screen when it finished` });
      else note = '\n\n(No screenshot with this one: the screen could not be captured, which usually means the PC is locked or its display is off.)';
    }
    const text = (result || '(finished with no summary)') + note;
    if (persistent && me.sessionId) {
      // Task finished, session stays: remember it before reporting so a follow-up can never find it missing.
      idle.set(job.id, { project: job.project, task: job.task, sessionId: me.sessionId, mode: 'persistent' });
      saveIdle();
      await ending(job, 'turn_done', { text, costUsd: cost, sessionId: me.sessionId });
      log('turn done, session kept open', job.id);
    } else {
      await ending(job, 'done', { text, costUsd: cost });
      log('done', job.id);
    }
  } catch (e) {
    const stopped = abort.signal.aborted;
    log(stopped ? `stopped${me.stopReason ? ` (${me.stopReason})` : ''}` : 'failed', job.id, e?.message ?? e);
    const text = !stopped
      ? String(e?.message ?? e).slice(0, 800)
      : me.stopReason === 'timeout'
        ? `It ran past the ${MAX_MINUTES}-minute limit and was stopped unfinished.${me.lastStep ? ` Last thing it was doing: ${me.lastStep}.` : ''}`
        : 'Stopped from the phone.';
    idle.delete(job.id); // a failed or stopped turn ends a persistent session too: say so, do not leave it half-alive
    saveIdle();
    await ending(job, 'error', { text, stopped });
  } finally {
    clearTimeout(limit);
    for (const [id, p] of pendingApprovals) if (p.jobId === job.id) pendingApprovals.delete(id);
    running.delete(job.id);
    finished.add(job.id);
    saveRunning();
  }
}

// ─── Poll loop ──────────────────────────────────────────────────────────────

async function loop() {
  log(`PC agent up → ${BASE} | projects: ${Object.keys(projects()).length} | parallel: ${MAX_PARALLEL}`);
  reportInterrupted();
  restoreIdle();
  void flushOutbox();
  setInterval(() => void flushOutbox(), 30_000);
  let backoff = 1000;
  for (;;) {
    try {
      // Each running session goes up with its project, task and open approvals,
      // so a relay that lost its memory (Railway restart) takes them back.
      const r = await api('/pc/agent/poll', {
        projects: Object.keys(projects()).sort(),
        idle: [...idle.entries()].map(([id, j]) => ({ id, project: j.project, task: j.task })),
        running: [...running.entries()].map(([id, j]) => ({
          id,
          project: j.project,
          task: j.task,
          mode: j.mode,
          approvals: [...pendingApprovals.entries()].filter(([, p]) => p.jobId === id).map(([approvalId, p]) => ({ approvalId, tool: p.tool, text: p.text })),
        })),
      });
      backoff = 1000;
      for (const d of r.decisions ?? []) pendingApprovals.get(d.id)?.resolve({ allow: d.allow, note: d.note });
      for (const id of r.stops ?? []) {
        running.get(id)?.abort.abort();
        if (idle.delete(id)) { saveIdle(); log('closed idle session', id); }
      }
      for (const f of r.followups ?? []) {
        if (running.has(f.id)) continue; // handed out twice
        const s = idle.get(f.id);
        if (!s) {
          await ending({ id: f.id, project: 'unknown', task: f.message, mode: 'persistent' }, 'error', { text: 'This persistent session is no longer open on the PC (the agent restarted or it was closed), so the follow-up was not run. Start a new session.' });
          continue;
        }
        if (running.size >= MAX_PARALLEL) {
          await ending({ id: f.id, project: s.project, task: f.message, mode: 'persistent' }, 'error', { text: `PC is already running ${running.size} sessions, so the follow-up was not run. The session was closed; start a new one.` });
          idle.delete(f.id); saveIdle();
          continue;
        }
        void runJob({ id: f.id, project: s.project, task: f.message, mode: 'persistent', resume: s.sessionId });
      }
      for (const job of r.jobs ?? []) {
        if (running.has(job.id) || finished.has(job.id)) continue; // handed out twice
        if (running.size >= MAX_PARALLEL) {
          finished.add(job.id);
          await ending(job, 'error', { text: `PC is already running ${running.size} sessions — try again when one finishes.` });
          continue;
        }
        void runJob(job);
      }
    } catch (e) {
      log('poll error:', e.message, `(retry in ${backoff / 1000}s)`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

process.on('unhandledRejection', (r) => log('unhandled:', r?.message ?? r));
void loop();
