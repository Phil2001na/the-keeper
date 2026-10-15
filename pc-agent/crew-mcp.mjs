// Meeseeks Prime's crew tools — a tiny MCP server (stdio, no dependencies).
//
// pc-agent/agent.mjs plugs this into Prime's session, whichever engine runs it
// (Codex via `-c mcp_servers.keeper_crew…`, Claude via the SDK's mcpServers).
// Every call goes to the Keeper relay (/pc/agent/crew) with the agent token, so
// workers are ordinary PC jobs: same queue, same approvals, same delivery.
//
// Env: KEEPER_PARENT_ID (Prime's job id, required), KEEPER_URL (optional).
// The token is read from the Keeper .env here, never passed on a command line.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = (() => {
  const out = {};
  const p = join(HERE, '..', '.env');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
})();
const BASE = (process.env.KEEPER_URL || ENV.KEEPER_URL || 'https://the-keeper-production.up.railway.app').replace(/\/$/, '');
const TOKEN = (process.env.REMOTE_BROWSER_TOKEN || ENV.REMOTE_BROWSER_TOKEN || '').replace(/\s+/g, '');
const PARENT = process.env.KEEPER_PARENT_ID || '';

const TOOLS = [
  {
    name: 'spawn_worker',
    description:
      'Spawn a worker: a fresh agent on the PC that does ONE job, reports back to you, and is gone. ' +
      'Give it the goal and what "done" looks like, plus any context it cannot find itself. Do not script the steps: ' +
      'it is as capable as you, and a procedure only makes it worse. Name it yourself, in the Rick and Morty spirit ' +
      '(a Meeseeks variant, a Rick or Morty from the Citadel, a Council member…) and make every name new. ' +
      'engine: "claude" for work in the browser (his Chrome), "codex" for driving the desktop itself (mouse, keyboard, ' +
      'native apps), either for code. It does not see your conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Its crew name. Funny, Rick and Morty flavoured, unique.' },
        goal: { type: 'string', description: 'What it must achieve and how you will judge it done. Intent, not instructions.' },
        engine: { type: 'string', enum: ['claude', 'codex'], description: 'claude (default): browser and code. codex: desktop control and code.' },
        project: { type: 'string', description: 'Project folder it works in. Defaults to yours.' },
        brief: { type: 'string', description: 'One line for the crew panel on his phone, e.g. "Breaking the SitePMS approval rules".' },
      },
      required: ['name', 'goal'],
    },
  },
  {
    name: 'crew_status',
    description: 'Your workers: who is alive, what each is doing, and the full report of each one that has ended.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wait_for_crew',
    description:
      'Block until none of your workers is still running (or the time runs out), then return crew_status. ' +
      'You do not have to wait: if you end your turn while workers run, you are woken with their reports when the last one finishes.',
    inputSchema: { type: 'object', properties: { minutes: { type: 'number', description: 'Longest to wait, 1-12. Default 10.' } } },
  },
  {
    name: 'record_lesson',
    description:
      'Write down a lesson every future agent on this PC will start with: a mistake a worker made that should never happen again, ' +
      'or a fact about how Philip wants things done. One short sentence, phrased as what to do. Only for lessons that will matter again.',
    inputSchema: { type: 'object', properties: { lesson: { type: 'string' } }, required: ['lesson'] },
  },
  {
    name: 'stop_worker',
    description: 'Stop one of your workers (it is told and reported as stopped).',
    inputSchema: { type: 'object', properties: { workerId: { type: 'string' } }, required: ['workerId'] },
  },
];

async function crew(op, extra = {}) {
  const res = await fetch(BASE + '/pc/agent/crew', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
    body: JSON.stringify({ op, parentId: PARENT, ...extra }),
  });
  if (!res.ok) throw new Error(`relay answered HTTP ${res.status}`);
  return res.json();
}

const LIVE = new Set(['queued', 'running', 'waiting', 'idle']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(name, args = {}) {
  if (!PARENT || !TOKEN) return { error: 'Crew tools are not configured (no parent id or agent token).' };
  switch (name) {
    case 'spawn_worker':
      return crew('spawn', { name: args.name, goal: args.goal, engine: args.engine, project: args.project, brief: args.brief });
    case 'crew_status':
      return crew('status');
    case 'stop_worker':
      return crew('stop', { workerId: args.workerId });
    case 'record_lesson':
      return crew('lesson', { lesson: args.lesson });
    case 'wait_for_crew': {
      const mins = Math.min(12, Math.max(1, Number(args.minutes) || 10));
      const until = Date.now() + mins * 60_000;
      for (;;) {
        const s = await crew('status');
        const alive = (s.workers ?? []).filter((w) => LIVE.has(w.status));
        if (!alive.length || Date.now() > until) return { ...s, stillRunning: alive.map((w) => w.name) };
        await sleep(8000);
      }
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ─── MCP over stdio: one JSON-RPC message per line ─────────────────────────

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications need no answer
  try {
    switch (m.method) {
      case 'initialize':
        return send({
          id: m.id,
          result: {
            protocolVersion: m.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'keeper-crew', version: '1.0.0' },
          },
        });
      case 'ping':
        return send({ id: m.id, result: {} });
      case 'tools/list':
        return send({ id: m.id, result: { tools: TOOLS } });
      case 'tools/call': {
        const out = await call(m.params?.name, m.params?.arguments ?? {});
        const isError = Boolean(out?.error) || out?.ok === false;
        return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], isError } });
      }
      default:
        return send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  } catch (e) {
    return send({ id: m.id, result: { content: [{ type: 'text', text: `Crew call failed: ${e.message}` }], isError: true } });
  }
});
