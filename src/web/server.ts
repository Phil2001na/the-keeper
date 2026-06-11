import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runAgent } from '../agent/orchestrator.js';
import { domains, facts, touchpoints, interactions, journal } from '../db/repositories.js';
import { drainMedia } from '../generate/queue.js';
import { bus, type KeeperEvent } from './bus.js';

/**
 * The web surface: one tiny HTTP server in the same process as the bot.
 *  GET  /            the UI (single self-contained file, no build step)
 *  GET  /events      SSE stream — live turn/step/message/card/media events
 *  POST /send        send a message to the agent from the browser
 *  GET  /api/snapshot  the keeper's mind: sectors, facts, plans, journal, history
 *
 * Auth: a single shared token (KEEPER_WEB_TOKEN). The browser asks once and
 * keeps it in localStorage. EventSource can't set headers, so /events accepts
 * the token as a query param — fine for a single-user app over HTTPS.
 */

const UI_PATH = fileURLToPath(new URL('./ui.html', import.meta.url));

const sseClients = new Set<ServerResponse>();

function authed(req: IncomingMessage): boolean {
  if (!config.webToken) return true;
  const url = new URL(req.url ?? '/', 'http://x');
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const token = bearer || url.searchParams.get('t') || '';
  return token.length > 0 && token === config.webToken;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function broadcast(event: KeeperEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text: string;
  try {
    const body = JSON.parse(await readBody(req)) as { text?: unknown };
    text = String(body.text ?? '').trim();
  } catch {
    json(res, 400, { ok: false, error: 'bad request body' });
    return;
  }
  if (!text) {
    json(res, 400, { ok: false, error: 'empty message' });
    return;
  }

  try {
    await runAgent({ kind: 'inbound', text, surface: 'web' });
    // Media generated this turn (images/PDFs) goes to the screen he's on.
    for (const item of drainMedia()) {
      const mime = item.kind === 'photo' ? 'image/png' : 'application/pdf';
      broadcast({
        type: 'media',
        kind: item.kind,
        dataUrl: `data:${mime};base64,${item.buffer.toString('base64')}`,
        filename: item.kind === 'document' ? item.filename : undefined,
      });
    }
    json(res, 200, { ok: true });
  } catch (err) {
    console.error('[web] runAgent failed:', err);
    broadcast({
      type: 'message',
      role: 'agent',
      content: '(something glitched on my end — try me again in a sec)',
      ts: new Date().toISOString(),
    });
    json(res, 500, { ok: false, error: 'agent error' });
  }
}

async function handleSnapshot(res: ServerResponse): Promise<void> {
  const [domainList, factList, pending, journalEntries, history] = await Promise.all([
    domains.list(),
    facts.all(),
    touchpoints.pending(),
    journal.recent(1),
    interactions.recent(40),
  ]);
  const slugById = new Map(domainList.map((d) => [d.id, d.slug]));
  json(res, 200, {
    domains: domainList.map((d) => ({
      slug: d.slug,
      name: d.name,
      priority: d.priority,
      description: d.description,
    })),
    facts: factList.map((f) => ({
      domain: f.domain_id ? slugById.get(f.domain_id) ?? '?' : 'general',
      key: f.key,
      value: f.value,
    })),
    touchpoints: pending.map((t) => ({ fireAt: t.fire_at, reason: t.reason })),
    journal: journalEntries[0] ?? null,
    history: history.map((h) => ({ role: h.role, content: h.content, ts: h.created_at })),
  });
}

function handleEvents(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

export function startWebServer(): void {
  if (!config.webToken) {
    console.log('[web] KEEPER_WEB_TOKEN not set — web UI running without auth.');
  }

  // Hold the page in memory; it's one file and never changes at runtime.
  const ui = readFileSync(UI_PATH);

  bus.subscribe(broadcast);

  // SSE connections die quietly on some proxies without traffic — heartbeat.
  setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25_000).unref();

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ui);
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    // Everything below requires the token.
    if (!authed(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method === 'GET' && path === '/events') {
      handleEvents(res);
      return;
    }
    if (req.method === 'POST' && path === '/send') {
      void handleSend(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/api/snapshot') {
      void handleSnapshot(res).catch((err) => {
        console.error('[web] snapshot failed:', err);
        json(res, 500, { ok: false });
      });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  });

  server.listen(config.port, () => {
    console.log(`[web] ui listening on :${config.port}`);
  });
}
