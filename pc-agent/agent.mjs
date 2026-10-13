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
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
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
const LOG_DIR = join(HERE, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

if (!TOKEN) {
  console.error('REMOTE_BROWSER_TOKEN missing (Keeper .env). Exiting.');
  process.exit(1);
}

/** jobId -> { abort: AbortController, project } */
const running = new Map();
/** approvalId -> resolve(decision) */
const pendingApprovals = new Map();

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

const event = (jobId, kind, extra = {}) =>
  api('/pc/agent/event', { jobId, kind, ...extra }).catch((e) => log('event failed', kind, e.message));

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
      (err) => {
        if (err) { log('screenshot failed:', String(err.message).split('\n')[0]); return resolve(null); }
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

async function runJob(job) {
  const proj = projects()[job.project];
  if (!proj) return event(job.id, 'error', { text: `Project "${job.project}" is not allowed on this PC.` });

  const abort = new AbortController();
  running.set(job.id, { abort, project: job.project });
  log('start', job.id, job.project, JSON.stringify(job.task.slice(0, 120)));

  const canUseTool = async (toolName, input, { signal }) => {
    const approvalId = randomUUID();
    const decision = new Promise((resolve) => {
      pendingApprovals.set(approvalId, resolve);
      signal.addEventListener('abort', () => resolve({ allow: false, note: 'aborted' }), { once: true });
    });
    await event(job.id, 'approval', { approvalId, tool: toolName, text: describe(toolName, input) });
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
        abortController: abort,
        // strict projects (EDU prod) ask for everything that isn't already allowed;
        // everything else uses auto mode, where only genuinely risky actions ask.
        permissionMode: proj.strict ? 'default' : 'auto',
        canUseTool,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: BRIEF },
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        await event(job.id, 'started', { sessionId: m.session_id });
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) await event(job.id, 'text', { text: b.text.trim().slice(0, 2000) });
          if (b.type === 'tool_use') await event(job.id, 'step', { text: stepText(b) });
        }
      } else if (m.type === 'result') {
        result = m.subtype === 'success' ? (m.result ?? '') : `Ended: ${m.subtype}${m.errors?.length ? ` — ${m.errors.join('; ')}` : ''}`;
        cost = m.total_cost_usd;
      }
    }
    const shot = CONFIG.screenshotOnFinish === false ? null : await screenshotB64();
    if (shot) await event(job.id, 'screenshot', { b64: shot, text: `${job.project}: screen when it finished` });
    await event(job.id, 'done', { text: result || '(finished with no summary)', costUsd: cost });
    log('done', job.id);
  } catch (e) {
    const stopped = abort.signal.aborted;
    log(stopped ? 'stopped' : 'failed', job.id, e?.message ?? e);
    await event(job.id, 'error', { text: stopped ? 'Stopped from the phone.' : String(e?.message ?? e).slice(0, 800), stopped });
  } finally {
    running.delete(job.id);
  }
}

// ─── Poll loop ──────────────────────────────────────────────────────────────

async function loop() {
  log(`PC agent up → ${BASE} | projects: ${Object.keys(projects()).length} | parallel: ${MAX_PARALLEL}`);
  let backoff = 1000;
  for (;;) {
    try {
      const r = await api('/pc/agent/poll', { projects: Object.keys(projects()).sort(), running: [...running.keys()] });
      backoff = 1000;
      for (const d of r.decisions ?? []) pendingApprovals.get(d.id)?.({ allow: d.allow, note: d.note });
      for (const id of r.stops ?? []) running.get(id)?.abort.abort();
      for (const job of r.jobs ?? []) {
        if (running.size >= MAX_PARALLEL) {
          await event(job.id, 'error', { text: `PC is already running ${running.size} sessions — try again when one finishes.` });
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
