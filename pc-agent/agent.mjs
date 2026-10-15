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
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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

/** Who a session is in the crew. Travels with every ending, poll and saved state, so a relay that restarted still knows it. */
const crewId = (j) => ({ name: j.name, role: j.role ?? 'solo', parentId: j.parentId, engine: j.engine ?? 'claude', model: j.model });

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
  const body = { jobId: job.id, kind, eid: randomUUID(), project: job.project, task: job.task, mode: job.mode ?? 'meeseeks', ...crewId(job), ...extra };
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
  const list = [...running.entries()].map(([id, r]) => ({ id, project: r.project, task: r.task, mode: r.mode, lastStep: r.lastStep, ...crewId(r) }));
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
    if (j?.id && j.project && j.sessionId) idle.set(j.id, { project: j.project, task: j.task, sessionId: j.sessionId, mode: 'persistent', ...crewId(j) });
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

// The standing rules every session carries in its system prompt, so the task
// itself can stay a goal. Whoever starts a session (the Keeper, Prime) states
// what is wanted; how to get there is the session's own call.
const BRIEF = `You were started by Philip's Keeper (his personal AI). He is NOT at the PC.
- You are given a goal, not a procedure. Work out the how yourself and use sensible defaults instead of stopping to ask.
- Logins: his Chrome and Google account are signed in. Use an existing session, or "Sign in with Google" / the saved login, before calling a site locked. Stop and report only when it truly needs him: a password nobody saved, a 2FA code, a security prompt. Never invent, guess or print credentials.
- Browser work: find your way by reading the page (text, accessibility tree) rather than screenshots. Take a screenshot only as evidence of something wrong, save it to a file, and cite the path; do not pile images into your context.
- Finish with a short plain-language report: what happened, what is left, anything he must do. Lead with the point, no jargon.`;

// How risky actions are gated depends on the engine.
const GATE = {
  claude: `
- Anything risky (sending messages or emails, deleting real data, payments, production deploys, anything on EDU prod) goes to his phone for Approve/Deny automatically. Just do it the normal way.`,
  codex: `
- There is no Approve/Deny on his phone for this session. Do not do anything irreversible or outward-facing (sending messages or emails, deleting real data, payments, production deploys): stop there and say exactly what you would do.`,
};

// Only added in the persistent mode. A one-task session never sees it.
const BRIEF_PERSISTENT = `
- This session stays open after you finish a task: he may send a follow-up on the same conversation, so you keep your context. End each task with the report; do not say the session is over.`;

const BRIEF_PRIME = `

You are Meeseeks Prime, Philip's chief of staff. The Keeper is his personal assistant and the voice he talks to; you are the one who gets big things done.
- You take goals of any kind (build, test, research, sort out) and own them until they are done. You decide how to split the work.
- You have a crew: the keeper_crew tools, and only those (no other sub-agent mechanism), because they are what shows on his phone. Spawn workers for parallel or specialist jobs, and do small things yourself. Name every worker in the Rick and Morty spirit (Meeseeks variants, Ricks and Mortys of the Citadel, Council members, whatever fits the job). Each name is new, and naming them is your job, not his.
- Brief workers the way you would want to be briefed: the goal, what done looks like, and context they cannot find. Never a step-by-step script; they are as capable as you. engine "claude" for the browser, "codex" for driving the desktop (mouse, keyboard, native apps).
- Check what they bring back before you rely on it. You can end your turn while they work: you are woken with their reports when the last one finishes.
- Your report goes to the Keeper, which passes the essentials to him in plain words. So report the substance: findings, decisions he must make, what is still open. Short beats complete.
- You stay open between asks until he says the job is done.`;

const briefWorker = (name) => `

You are ${name}, a worker in Meeseeks Prime's crew. You exist to do this one job: do it, report, and you are done. Your report goes to Prime, so make it complete enough to act on (exact steps to reproduce, what you expected, what happened, evidence paths).`;

function systemBrief(job, engine) {
  let b = BRIEF + GATE[engine];
  if (job.mode === 'persistent') b += BRIEF_PERSISTENT;
  if (job.role === 'prime') b += BRIEF_PRIME;
  if (job.role === 'worker') b += briefWorker(job.name || 'a Meeseeks');
  return b;
}

const CREW_MCP = join(HERE, 'crew-mcp.mjs');
const CREW_TOOLS = ['spawn_worker', 'crew_status', 'wait_for_crew', 'stop_worker'].map((t) => `mcp__keeper_crew__${t}`);

// ─── Engines ────────────────────────────────────────────────────────────────
// Each engine runs one task of a session and reports through the same hooks:
// onStarted(sessionId), onText(text), onStep(text). It resolves with the final
// report and the cost if the engine knows it.

async function runClaude(job, proj, me, hooks) {
  const canUseTool = async (toolName, input, { signal }) => {
    if (CREW_TOOLS.includes(toolName)) return { behavior: 'allow', updatedInput: input };
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
  const q = query({
    prompt: job.task,
    options: {
      cwd: proj.path,
      ...(job.resume ? { resume: job.resume } : {}),
      ...(job.model ? { model: job.model } : {}),
      abortController: me.abort,
      // strict projects (EDU prod) ask for everything that isn't already allowed;
      // everything else uses auto mode, where only genuinely risky actions ask.
      permissionMode: proj.strict ? 'default' : 'auto',
      canUseTool,
      settingSources: ['user', 'project', 'local'],
      ...(job.role === 'prime'
        ? {
            mcpServers: { keeper_crew: { type: 'stdio', command: process.execPath, args: [CREW_MCP], env: { KEEPER_PARENT_ID: job.id, KEEPER_URL: BASE } } },
            allowedTools: CREW_TOOLS,
          }
        : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemBrief(job, 'claude') },
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      await hooks.onStarted(m.session_id);
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) await hooks.onText(b.text.trim());
        if (b.type === 'tool_use') await hooks.onStep(stepText(b));
      }
    } else if (m.type === 'result') {
      result = m.subtype === 'success' ? (m.result ?? '') : `Ended: ${m.subtype}${m.errors?.length ? ` — ${m.errors.join('; ')}` : ''}`;
      cost = m.total_cost_usd;
    }
  }
  return { result, cost };
}

// Codex runs as `codex exec --json` (one task per process; a follow-up is
// `codex exec resume <thread>`). It is started through node + codex.js, not the
// .cmd shim, so no shell ever parses the prompt; the prompt goes in on stdin.
// It runs on his ChatGPT plan with his ~/.codex/config.toml (sandbox, plugins).
const CODEX_JS = CONFIG.codexJs || join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const toml = (v) => JSON.stringify(v); // a JSON string is a valid TOML basic string

function codexStep(item) {
  const short = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 140);
  switch (item.type) {
    case 'command_execution': return `running: ${short(String(item.command ?? '').replace(/^"[^"]*powershell\.exe"\s+-Command\s+/i, ''))}`;
    case 'file_change': return `editing ${short((item.changes ?? []).map((c) => c.path).join(', ') || 'files')}`;
    case 'mcp_tool_call': return `using ${short(`${item.server ?? ''} ${item.tool ?? ''}`.trim())}`;
    case 'web_search': return `web search: ${short(item.query)}`;
    default: return null;
  }
}

function runCodex(job, proj, me, hooks) {
  if (!existsSync(CODEX_JS)) return Promise.reject(new Error(`Codex is not installed where the agent looks (${CODEX_JS}). Set codexJs in projects.json.`));
  const args = [CODEX_JS, 'exec'];
  if (job.resume) args.push('resume');
  // Codex's own sub-agents would be invisible to him: the crew is keeper_crew only.
  args.push('--json', '--skip-git-repo-check', '--disable', 'multi_agent');
  if (job.model) args.push('-m', job.model);
  args.push('-c', `developer_instructions=${toml(systemBrief(job, 'codex'))}`);
  if (job.role === 'prime') {
    args.push(
      '-c', `mcp_servers.keeper_crew.command=${toml(process.execPath)}`,
      '-c', `mcp_servers.keeper_crew.args=[${toml(CREW_MCP)}]`,
      '-c', `mcp_servers.keeper_crew.env={ KEEPER_PARENT_ID = ${toml(job.id)}, KEEPER_URL = ${toml(BASE)} }`,
      '-c', 'mcp_servers.keeper_crew.tool_timeout_sec=900',
    );
  }
  if (job.resume) args.push(job.resume);
  args.push('-');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: proj.path, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Abort kills the whole tree: codex.js starts the native binary as its child.
    const kill = () => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => { if (err) child.kill(); });
    me.abort.signal.addEventListener('abort', kill, { once: true });
    child.stdin.end(job.task);

    let result = '';
    let failure = '';
    let errTail = '';
    let chain = Promise.resolve();
    createInterface({ input: child.stdout }).on('line', (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      chain = chain.then(async () => {
        if (e.type === 'thread.started' && e.thread_id) await hooks.onStarted(e.thread_id);
        else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text?.trim()) {
          result = e.item.text.trim();
          await hooks.onText(result);
        } else if (e.type === 'item.started' && e.item) {
          const step = codexStep(e.item);
          if (step) await hooks.onStep(step);
        } else if (e.type === 'turn.failed' || e.type === 'error') {
          failure = String(e.error?.message ?? e.message ?? 'Codex reported an error').slice(0, 800);
        }
      }).catch(() => {});
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
    child.on('error', (err) => reject(err));
    child.on('close', async (code) => {
      await chain;
      if (me.abort.signal.aborted) return reject(new Error('aborted'));
      if (failure && !result) return reject(new Error(failure));
      if (code !== 0 && !result) {
        // His other MCP servers (Lovable etc.) log auth noise on stderr; that is not why it failed.
        const why = errTail.split(/\r?\n/).filter((l) => l.trim() && !/rmcp::transport|AuthRequired|Reading additional input/.test(l)).slice(-3).join(' | ');
        return reject(new Error(`Codex exited with code ${code}${why ? `: ${why.slice(0, 600)}` : ''}`));
      }
      resolve({ result: failure && result ? `${result}\n\n(Codex also reported: ${failure})` : result, cost: undefined });
    });
  });
}

async function runJob(job) {
  const proj = projects()[job.project];
  if (!proj) return ending(job, 'error', { text: `Project "${job.project}" is not allowed on this PC.` });

  const abort = new AbortController();
  const persistent = job.mode === 'persistent';
  const me = { abort, project: job.project, task: job.task, mode: job.mode ?? 'meeseeks', lastStep: '', stopReason: '', ...crewId(job) };
  idle.delete(job.id); // a follow-up: it is running again
  saveIdle();
  running.set(job.id, me);
  saveRunning();
  log('start', job.id, job.project, JSON.stringify(job.task.slice(0, 120)));
  const limit = setTimeout(() => {
    me.stopReason = 'timeout';
    abort.abort();
  }, MAX_MINUTES * 60_000);

  // Codex has no Approve/Deny channel, so strict projects (EDU prod) always run on Claude.
  const engine = job.engine === 'codex' && !proj.strict ? 'codex' : 'claude';
  me.engine = engine;
  if (job.engine === 'codex' && engine === 'claude') log('codex refused on strict project, using claude', job.id, job.project);
  const hooks = {
    onStarted: async (sessionId) => {
      me.sessionId = sessionId;
      // A resumed turn is the same session: do not announce "started" again.
      if (!job.resume) await event(job.id, 'started', { sessionId });
    },
    onText: (text) => event(job.id, 'text', { text: text.slice(0, 2000) }),
    onStep: async (text) => {
      me.lastStep = text;
      saveRunning();
      await event(job.id, 'step', { text });
    },
  };

  try {
    const { result, cost } = engine === 'codex' ? await runCodex(job, proj, me, hooks) : await runClaude(job, proj, me, hooks);
    // The SDK can end the stream quietly when aborted; that is a stop, not a finish.
    if (abort.signal.aborted) throw new Error('aborted');
    let note = '';
    // Only a session he started directly gets a finish screenshot: Prime and its
    // workers report in words, and a desktop picture per worker is just noise.
    if (CONFIG.screenshotOnFinish !== false && (job.role ?? 'solo') === 'solo') {
      const shot = await screenshotB64();
      if (shot) await event(job.id, 'screenshot', { b64: shot, text: `${job.project}: screen when it finished` });
      else note = '\n\n(No screenshot with this one: the screen could not be captured, which usually means the PC is locked or its display is off.)';
    }
    const text = (result || '(finished with no summary)') + note;
    if (persistent && me.sessionId) {
      // Task finished, session stays: remember it before reporting so a follow-up can never find it missing.
      idle.set(job.id, { project: job.project, task: job.task, sessionId: me.sessionId, mode: 'persistent', ...crewId(me) });
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
        idle: [...idle.entries()].map(([id, j]) => ({ id, project: j.project, task: j.task, ...crewId(j) })),
        running: [...running.entries()].map(([id, j]) => ({
          id,
          project: j.project,
          task: j.task,
          mode: j.mode,
          ...crewId(j),
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
          await ending({ id: f.id, project: s.project, task: f.message, mode: 'persistent', ...crewId(s) }, 'error', { text: `PC is already running ${running.size} sessions, so the follow-up was not run. The session was closed; start a new one.` });
          idle.delete(f.id); saveIdle();
          continue;
        }
        void runJob({ id: f.id, project: s.project, task: f.message, mode: 'persistent', resume: s.sessionId, ...crewId(s) });
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
