/**
 * Local preview harness for the web surface.
 *
 *   npm run ui        →  http://localhost:5173   (access token: 1234)
 *
 * Why this exists: `npm run dev` boots the whole agent — including the Telegram
 * long-poll, which fights the live Railway instance for the same bot token and
 * knocks the real Keeper offline. This serves the same files against canned
 * data instead, so the UI can be worked on without touching production.
 *
 * It deliberately does NOT import src/config.ts (that throws without a full
 * .env) or src/web/server.ts (that would pull in Supabase and the agent loop).
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const WEB = fileURLToPath(new URL('../src/web/', import.meta.url));
const PORT = Number(process.env.UI_PORT ?? 5173);
const TOKEN = '1234';
const PREVIEW_VERSION = `preview-${Date.now().toString(36)}`;

/**
 * Notifications work here for real — same library, same encryption, same
 * routes as src/web/push.ts. The keypair is ephemeral (regenerated on every
 * start), which is exactly what you want in a preview: a restart invalidates
 * the old subscription, and app.js's key check re-subscribes on next load.
 */
const VAPID = webpush.generateVAPIDKeys();
webpush.setVapidDetails('mailto:preview@localhost', VAPID.publicKey, VAPID.privateKey);
const subs = new Map<string, webpush.PushSubscription>();

async function pushAll(payload: Record<string, unknown>): Promise<number> {
  let sent = 0;
  await Promise.all(
    [...subs.values()].map(async (s) => {
      try {
        await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 });
        sent++;
      } catch (err) {
        subs.delete(s.endpoint);
        console.warn('  push failed, dropped subscription:', (err as Error).message);
      }
    })
  );
  return sent;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const clients = new Set<ServerResponse>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SNAPSHOT = {
  domains: [
    { slug: 'work', name: 'Work & building', priority: 1, description: 'EDU refactor, Keeper, the client pipeline' },
    { slug: 'health', name: 'Body', priority: 2, description: 'the jaw, sleep, back to the gym' },
    { slug: 'money', name: 'Money', priority: 2, description: 'runway, invoices out, what actually landed' },
    { slug: 'people', name: 'People', priority: 3, description: 'family, the ones who reach out' },
  ],
  facts: [
    { domain: 'work', key: 'main income', value: 'EDU refactor for the Welwitch client' },
    { domain: 'work', key: 'shipping', value: 'Keeper web surface — PWA + redesign' },
    { domain: 'health', key: 'jaw', value: 'surgery follow-up still pending' },
    { domain: 'money', key: 'invoice', value: 'N$18,400 outstanding, 21 days' },
    { domain: 'people', key: 'brother', value: 'working on the JUMO-style lending idea together' },
  ],
  goals: [
    { title: 'Ship Keeper as a real installable app', metric: null, target: null, unit: null, deadline: '2026-08-10', why: 'it should feel like a product' },
    { title: 'Gym three times a week', metric: 'gym.sessions', target: 3, unit: '/week', deadline: null, why: null },
  ],
  metrics: [
    { metric: 'sleep.hours', value: 6.4, unit: 'h', at: '2026-07-28T22:00:00Z' },
    { metric: 'gym.sessions', value: 2, unit: '/week', at: '2026-07-27T18:00:00Z' },
  ],
  spendTodayUsd: 0.42,
  digest: null,
  touchpoints: [
    { fireAt: new Date(Date.now() + 5 * 3600e3).toISOString(), reason: 'check whether the Welwitch deploy actually went out', recurrence: null },
    { fireAt: new Date(Date.now() + 26 * 3600e3).toISOString(), reason: 'morning read on the day', recurrence: 'daily' },
  ],
  journal: {
    day: '2026-07-28',
    entry: 'He shipped the Drive PDF fix without being asked twice. The pattern I keep seeing: he goes quiet for a day, then three things land at once. Not stuck — batching.',
  },
  history: [
    { role: 'agent', content: 'morning. you left the icon generator half-finished last night — want to pick it up, or is today an EDU day?', ts: new Date(Date.now() - 3600e3 * 3).toISOString() },
    { role: 'user', content: 'keeper day. i want it installable on my phone by tonight', ts: new Date(Date.now() - 3600e3 * 2.9).toISOString() },
    { role: 'agent', content: 'good. that\'s a **manifest**, a service worker and real icons — the icons are the part people skip and then wonder why the install prompt never shows.\n\nyou\'ve got `gen-icons.ts` already emitting the orb. what\'s left is the caching story.', ts: new Date(Date.now() - 3600e3 * 2.8).toISOString() },
  ],
};

/** A scripted turn, so every live state (steps, cards, media) can be seen. */
async function fakeTurn(text: string): Promise<void> {
  const emit = (e: unknown) => { for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`); };

  emit({ type: 'turn', phase: 'start', source: 'inbound' });
  emit({ type: 'message', role: 'user', content: text, ts: new Date().toISOString() });
  await sleep(700);
  emit({ type: 'step', label: 'consulting my memory' });
  await sleep(1100);
  emit({ type: 'step', label: 'reading the trends' });
  await sleep(900);
  emit({ type: 'step', label: 'arranging a view' });
  await sleep(700);
  emit({
    type: 'message',
    role: 'agent',
    content: 'pulled the week together. sleep is the one actually moving — the gym number is flat and you know it.',
    ts: new Date().toISOString(),
  });
  emit({
    type: 'card',
    card: {
      title: 'THE WEEK',
      blocks: [
        { type: 'stat', label: 'average sleep', value: '6.4h', delta: '+0.8', hint: 'best stretch since the surgery' },
        { type: 'spark', label: 'sleep', unit: 'h', points: [5.1, 5.4, 6.0, 5.8, 6.6, 7.1, 6.4] },
        { type: 'progress', label: 'gym sessions', value: 66, hint: '2 of 3 — thursday is still open' },
        { type: 'list', title: 'still on the table', items: [
          { text: 'Welwitch admission-letter fix', sub: 'verified on prod', done: true },
          { text: 'Keeper PWA', sub: 'icons done, caching next' },
          { text: 'invoice follow-up', sub: '21 days out' },
        ] },
        { type: 'keyvals', pairs: [
          { k: 'api spend today', v: '$0.42' },
          { k: 'outstanding', v: 'N$18,400' },
        ] },
        { type: 'quote', text: 'Not stuck — batching.', by: 'last night\'s journal' },
      ],
    },
  });
  await sleep(400);
  emit({ type: 'turn', phase: 'end', source: 'inbound' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const authed = (bearer || url.searchParams.get('t') || '') === TOKEN;

  if (path === '/events') {
    if (!authed) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (path === '/api/snapshot') {
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(SNAPSHOT));
    return;
  }

  // ── notifications (mirrors src/web/server.ts) ────────────────────────────
  if (path.startsWith('/api/push/')) {
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    const reply = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (path === '/api/push/key') { reply({ key: VAPID.publicKey }); return; }

    let body = '';
    for await (const chunk of req) body += chunk;

    if (path === '/api/push/subscribe') {
      const sub = JSON.parse(body || '{}') as webpush.PushSubscription;
      subs.set(sub.endpoint, sub);
      console.log(`  + subscribed (${subs.size} device${subs.size === 1 ? '' : 's'})`);
      reply({ ok: true });
      return;
    }
    if (path === '/api/push/unsubscribe') {
      subs.delete((JSON.parse(body || '{}') as { endpoint: string }).endpoint);
      console.log(`  - unsubscribed (${subs.size} left)`);
      reply({ ok: true });
      return;
    }
    if (path === '/api/push/test') {
      const sent = await pushAll({
        title: 'keeper',
        body: 'this is what it looks like when i reach out.',
        tag: 'keeper-test',
        url: '/',
        ts: new Date().toISOString(),
        force: true,
      });
      reply({ ok: sent > 0, sent, devices: subs.size });
      return;
    }
    // Not in the real server: fires a *proactive* push after a delay, so you
    // can close the tab and see what an actual reach-out looks like.
    if (path === '/api/push/reachout') {
      const delay = Number(url.searchParams.get('in') ?? 8);
      console.log(`  reach-out scheduled in ${delay}s — close the tab`);
      setTimeout(() => {
        void pushAll({
          title: 'keeper',
          body: 'you said you\'d call your mother back — it\'s been four days.',
          tag: `keeper-${Date.now()}`,
          url: '/',
          ts: new Date().toISOString(),
        }).then((n) => console.log(`  reach-out pushed to ${n} device(s)`));
      }, delay * 1000);
      reply({ ok: true, in: delay });
      return;
    }
    res.writeHead(404).end();
    return;
  }

  if (path === '/send' && req.method === 'POST') {
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const text = (() => { try { return JSON.parse(body).text as string; } catch { return ''; } })();
    void fakeTurn(text || '(attachment)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Static: the real files, straight off disk so edits show up on reload.
  const file = path === '/' || path === '/index.html' ? 'ui.html' : path.slice(1);
  const full = join(WEB, file);
  if (!full.startsWith(WEB) || !existsSync(full) || !MIME[extname(full)]) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = readFileSync(full);
  // Boot-stamped so restarting the harness pushes a genuine service-worker
  // update — the same code path a deploy takes.
  if (file === 'sw.js') body = Buffer.from(body.toString('utf-8').replace('__VERSION__', PREVIEW_VERSION));
  res.writeHead(200, { 'Content-Type': MIME[extname(full)]!, 'Cache-Control': 'no-store' });
  res.end(body);
});

if (!existsSync(join(WEB, 'icons'))) {
  console.warn('! no src/web/icons — run `npm run icons` first');
} else {
  console.log(`  ${readdirSync(join(WEB, 'icons')).length} icons available`);
}

server.listen(PORT, () => {
  console.log(`\n  THE KEEPER — ui preview`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  access token: ${TOKEN}`);
  console.log(`  proactive reach-out: curl -X POST "http://localhost:${PORT}/api/push/reachout?in=8&t=${TOKEN}"\n`);
});
