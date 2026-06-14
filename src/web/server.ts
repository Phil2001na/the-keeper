import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runAgent, type InboundImage, type InboundPdf } from '../agent/orchestrator.js';
import { localMidnightUtc } from '../agent/recurrence.js';
import {
  digests,
  domains,
  facts,
  goals,
  observations,
  touchpoints,
  interactions,
  journal,
} from '../db/repositories.js';
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

/** Allowed image types map (mirrors the model's vision support). */
const IMAGE_TYPES: Record<string, InboundImage['mediaType']> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

interface UploadFile {
  name?: string;
  mime?: string;
  data?: string; // base64, no data-URL prefix
}

async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text: string;
  let files: UploadFile[];
  try {
    // Files (images/PDFs) ride in as base64 — allow a generous body.
    const body = JSON.parse(await readBody(req, 20 * 1024 * 1024)) as { text?: unknown; files?: unknown };
    text = String(body.text ?? '').trim();
    files = Array.isArray(body.files) ? (body.files as UploadFile[]) : [];
  } catch {
    json(res, 400, { ok: false, error: 'bad request body' });
    return;
  }
  if (!text && files.length === 0) {
    json(res, 400, { ok: false, error: 'empty message' });
    return;
  }

  // Split attachments into vision images and native PDFs.
  const images: InboundImage[] = [];
  const pdfs: InboundPdf[] = [];
  for (const f of files) {
    const data = typeof f.data === 'string' ? f.data : '';
    if (!data) continue;
    const mime = (f.mime ?? '').toLowerCase();
    const ext = (f.name ?? '').toLowerCase().match(/\.\w+$/)?.[0] ?? '';
    if (mime === 'application/pdf' || ext === '.pdf') {
      pdfs.push({ base64: data, filename: f.name });
    } else {
      const mediaType = IMAGE_TYPES[mime] ?? IMAGE_TYPES[`image/${ext.slice(1)}`];
      if (mediaType) images.push({ mediaType, base64: data });
    }
  }

  try {
    await runAgent({
      kind: 'inbound',
      text,
      surface: 'web',
      images: images.length ? images : undefined,
      pdfs: pdfs.length ? pdfs : undefined,
    });
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
  const [domainList, factList, pending, journalEntries, history, goalList, latestObs, dayTurns, dig] =
    await Promise.all([
      domains.list(),
      facts.all(),
      touchpoints.pending(),
      journal.recent(1),
      interactions.recent(40),
      goals.list(true),
      observations.latestPerMetric(),
      observations.series('sys.turn', localMidnightUtc().toISOString()).catch(() => []),
      digests.get('rolling').catch(() => null),
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
    goals: goalList.map((g) => ({
      title: g.title,
      metric: g.metric,
      target: g.target_value,
      unit: g.unit,
      deadline: g.deadline,
      why: g.why,
    })),
    metrics: latestObs
      .filter((o) => !o.metric.startsWith('sys.'))
      .map((o) => ({
        metric: o.metric,
        value: o.value ?? o.text_value,
        unit: o.unit,
        at: o.observed_at,
      })),
    spendTodayUsd: dayTurns.reduce((a, r) => a + Number(r.value ?? 0), 0),
    digest: dig ? { content: dig.content, coveredUntil: dig.covered_until } : null,
    touchpoints: pending.map((t) => ({ fireAt: t.fire_at, reason: t.reason, recurrence: t.recurrence })),
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
