import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Remote browser: Philip logs in to job sites from his phone, inside Keeper.
 *
 * The browser itself runs on his PC (job-scout's remote_agent.mjs drives a
 * headless Chrome on the job-scout login profile). The PC never accepts
 * connections: it calls OUT to this relay, so nothing on the PC is exposed.
 *
 *   PC agent  ──POST frame──▶  relay  ──SSE──▶  /remote page (phone)
 *   PC agent  ◀──long-poll──   relay  ◀─POST──  taps / text / keys
 *
 * Two different credentials:
 *  - /rb/agent/*  REMOTE_BROWSER_TOKEN, held only by the PC agent.
 *  - /rb/* (viewer) the normal KEEPER_WEB_TOKEN gate (passed in as `authed`).
 *
 * Typed text (passwords) only ever sits in the in-memory input queue until the
 * agent collects it. It is never logged, stored or put on the bus.
 *
 * Second lock: every session has a random key that the PC sends Philip on
 * Telegram as part of the /remote?k=... link. Seeing frames or sending input
 * needs that key as well as the web token, so the web token alone (which has
 * been short) can't open a browser that holds his logins.
 *
 *  GET  /remote               the viewer page (shell is public, like ui.html)
 *  GET  /rb/events            SSE: frame / status events            (viewer)
 *  POST /rb/input             one input event                      (viewer)
 *  POST /rb/request           ask the PC to open a login session   (viewer)
 *  POST /rb/agent/hello       PC listener check-in + takes requests (agent)
 *  POST /rb/agent/frame       JPEG body, X-Meta header             (agent)
 *  POST /rb/agent/status      session state + tabs                 (agent)
 *  GET  /rb/agent/poll        long-poll for input events           (agent)
 */

const WEB_DIR = fileURLToPath(new URL('./', import.meta.url));
const AGENT_TOKEN = (process.env.REMOTE_BROWSER_TOKEN ?? '').replace(/\s+/g, '');

const MAX_FRAME = 3 * 1024 * 1024;
const MAX_QUEUE = 200;
const POLL_MS = 25_000;
const AGENT_ALIVE_MS = 45_000;
const LISTENER_ALIVE_MS = 5 * 60_000;

interface Frame {
  seq: number;
  meta: Record<string, unknown>;
  b64: string;
}

interface Status {
  state: 'idle' | 'starting' | 'live' | 'ended';
  tabs?: { title: string; url: string; active: boolean }[];
  note?: string;
  at: number;
}

type InputEvent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'scroll'; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'back' }
  | { type: 'reload' }
  | { type: 'goto'; url: string }
  | { type: 'tab'; index: number }
  | { type: 'done' };

const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const viewers = new Map<ServerResponse, string>(); // viewer -> session key it presented
let frame: Frame | null = null;
let seq = 0;
let status: Status = { state: 'idle', at: Date.now() };
let queue: InputEvent[] = [];
let waiter: ServerResponse | null = null;
let agentSeen = 0;
let listenerSeen = 0;
let sites: string[] = [];
let pendingRequest: { site: string; at: number } | null = null;
let sessionKey = '';

function keyOk(k: string | null | undefined): boolean {
  if (!sessionKey || !k) return false;
  const a = Buffer.from(k), b = Buffer.from(sessionKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

let page: Buffer | null = null;
function viewerPage(): Buffer {
  page ??= readFileSync(join(WEB_DIR, 'remote.html'));
  return page;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function agentAuthed(req: IncomingMessage): boolean {
  if (!AGENT_TOKEN) return false; // feature off until the token is configured
  const got = Buffer.from(String(req.headers['x-agent-token'] ?? ''));
  const want = Buffer.from(AGENT_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage, max = 16 * 1024): Promise<T> {
  return JSON.parse((await readRaw(req, max)).toString('utf-8')) as T;
}

function send(res: ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    viewers.delete(res);
  }
}

function publicStatus() {
  const agentAlive = Date.now() - agentSeen < AGENT_ALIVE_MS;
  return {
    ...status,
    state: agentAlive || status.state === 'starting' ? status.state : status.state === 'live' ? 'ended' : status.state,
    pcOnline: Date.now() - listenerSeen < LISTENER_ALIVE_MS || agentAlive,
    sites,
    pending: pendingRequest?.site ?? null,
  };
}

function broadcastStatus(): void {
  const s = publicStatus();
  for (const [v, k] of viewers) send(v, 'status', { ...s, keyOk: keyOk(k) });
}

function flush(): void {
  if (!waiter || queue.length === 0) return;
  const res = waiter;
  waiter = null;
  json(res, 200, { events: queue.splice(0) });
}

/** Validate and normalise one viewer input. Returns null if it's junk. */
function cleanInput(raw: Record<string, unknown>): InputEvent | null {
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
  switch (raw.type) {
    case 'tap': {
      const x = num(raw.x, 0, 1), y = num(raw.y, 0, 1);
      return x === null || y === null ? null : { type: 'tap', x, y };
    }
    case 'scroll': {
      const dy = num(raw.dy, -5000, 5000);
      return dy === null ? null : { type: 'scroll', dy };
    }
    case 'text':
      return typeof raw.text === 'string' && raw.text.length > 0 && raw.text.length <= 1000
        ? { type: 'text', text: raw.text } : null;
    case 'key':
      return typeof raw.key === 'string' && KEYS.has(raw.key) ? { type: 'key', key: raw.key } : null;
    case 'goto':
      return typeof raw.url === 'string' && /^https?:\/\/\S+$/i.test(raw.url) && raw.url.length < 2048
        ? { type: 'goto', url: raw.url } : null;
    case 'tab': {
      const i = num(raw.index, 0, 50);
      return i === null ? null : { type: 'tab', index: Math.floor(i) };
    }
    case 'back': case 'reload': case 'done':
      return { type: raw.type };
    default:
      return null;
  }
}

/** Returns true if it handled the request. `authed` = the normal web token check. */
export function handleRemoteBrowser(req: IncomingMessage, res: ServerResponse, path: string, authed: boolean): boolean {
  if (req.method === 'GET' && path === '/remote') {
    const body = viewerPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
    res.end(body);
    return true;
  }
  if (!path.startsWith('/rb/')) return false;

  // ── PC agent ──────────────────────────────────────────────────────────────
  if (path.startsWith('/rb/agent/')) {
    if (!agentAuthed(req)) {
      json(res, 401, { ok: false });
      return true;
    }
    if (req.method === 'POST' && path === '/rb/agent/hello') {
      void readJson<{ sites?: unknown }>(req).then((b) => {
        listenerSeen = Date.now();
        if (Array.isArray(b.sites)) sites = b.sites.filter((s): s is string => typeof s === 'string').slice(0, 20);
        const take = pendingRequest;
        pendingRequest = null;
        if (take) {
          status = { state: 'starting', note: `opening ${take.site}…`, at: Date.now() };
          broadcastStatus();
        }
        json(res, 200, { ok: true, request: take });
      }).catch(() => json(res, 400, { ok: false }));
      return true;
    }
    if (req.method === 'POST' && path === '/rb/agent/frame') {
      void readRaw(req, MAX_FRAME).then((buf) => {
        agentSeen = Date.now();
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(String(req.headers['x-meta'] ?? '{}')) as Record<string, unknown>;
        } catch { /* keep empty */ }
        frame = { seq: ++seq, meta, b64: buf.toString('base64') };
        for (const [v, k] of viewers) if (keyOk(k)) send(v, 'frame', frame);
        json(res, 200, { ok: true });
      }).catch(() => json(res, 413, { ok: false }));
      return true;
    }
    if (req.method === 'POST' && path === '/rb/agent/status') {
      void readJson<Partial<Status> & { key?: unknown }>(req).then((b) => {
        if (typeof b.key === 'string' && b.key.length >= 20 && b.key.length <= 200) sessionKey = b.key;
        agentSeen = Date.now();
        const state = b.state && ['starting', 'live', 'ended'].includes(b.state) ? b.state : status.state;
        status = { state, tabs: Array.isArray(b.tabs) ? b.tabs.slice(0, 20) : status.tabs, note: typeof b.note === 'string' ? b.note.slice(0, 300) : undefined, at: Date.now() };
        if (state === 'ended') {
          sessionKey = '';
          frame = null;
          queue = [];
        }
        broadcastStatus();
        json(res, 200, { ok: true });
      }).catch(() => json(res, 400, { ok: false }));
      return true;
    }
    if (req.method === 'GET' && path === '/rb/agent/poll') {
      agentSeen = Date.now();
      if (waiter) json(waiter, 200, { events: [] }); // only one agent at a time
      waiter = res;
      const t = setTimeout(() => {
        if (waiter === res) {
          waiter = null;
          json(res, 200, { events: [] });
        }
      }, POLL_MS);
      res.on('close', () => {
        clearTimeout(t);
        if (waiter === res) waiter = null;
      });
      flush();
      return true;
    }
    json(res, 404, { ok: false });
    return true;
  }

  // ── viewer (phone) ────────────────────────────────────────────────────────
  if (!authed) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }
  if (req.method === 'GET' && path === '/rb/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const k = new URL(req.url ?? '/', 'http://x').searchParams.get('k') ?? '';
    viewers.set(res, k);
    send(res, 'status', { ...publicStatus(), keyOk: keyOk(k) });
    if (frame && keyOk(k) && Date.now() - agentSeen < AGENT_ALIVE_MS) send(res, 'frame', frame);
    const ping = setInterval(() => send(res, 'status', { ...publicStatus(), keyOk: keyOk(k) }), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      viewers.delete(res);
    });
    return true;
  }
  if (req.method === 'POST' && path === '/rb/input') {
    if (!keyOk(String(req.headers['x-session-key'] ?? ''))) {
      json(res, 403, { ok: false, error: 'open the link Keeper sent you on Telegram' });
      return true;
    }
    void readJson<Record<string, unknown>>(req).then((b) => {
      const ev = cleanInput(b);
      if (!ev) return json(res, 400, { ok: false, error: 'bad input' });
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(ev);
      flush();
      json(res, 200, { ok: true });
    }).catch(() => json(res, 400, { ok: false }));
    return true;
  }
  if (req.method === 'POST' && path === '/rb/request') {
    void readJson<{ site?: unknown }>(req).then((b) => {
      const site = typeof b.site === 'string' ? b.site.trim().toLowerCase().slice(0, 40) : '';
      if (!site) return json(res, 400, { ok: false, error: 'which site?' });
      pendingRequest = { site, at: Date.now() };
      broadcastStatus();
      json(res, 200, { ok: true });
    }).catch(() => json(res, 400, { ok: false }));
    return true;
  }
  json(res, 404, { ok: false, error: 'not found' });
  return true;
}
