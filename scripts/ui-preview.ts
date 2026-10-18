import { workstreamApi } from '../src/web/workstreams.js';
import { empty, createStream, appendEvent } from '../src/workstreams/model.js';
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
import { generatePdf } from '../src/generate/pdf.js';
import { generateMarkdown } from '../src/generate/markdown.js';
import { getFile, putFile, safeFilename } from '../src/web/files.js';
import { DictationError, transcribe } from '../src/web/dictate.js';
import { SpeechError, synthesize } from '../src/web/speak.js';

/** A soft fading 330 Hz tone as 16-bit mono WAV — the preview's stand-in voice. */
function toneWav(seconds: number): Buffer {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * env * 6000), 44 + i * 2);
  }
  return buf;
}

const WEB = fileURLToPath(new URL('../src/web/', import.meta.url));
const PORT = Number(process.env.UI_PORT ?? 5173);
const TOKEN = '1234';
let workState = empty();
const area = createStream(workState, {title:'Job Search'});
const application = createStream(workState, {title:'Supabase application', parentId:area.id});
createStream(workState, {title:'Roblox UGC sales'});
// A realistic thread: two days, briefs on most entries, one left without so the
// first-sentence fallback is visible too.
const sample: [string, string, string, number, import('../src/workstreams/model.js').Brief | undefined][] = [
  [area.id, 'Workstreams setup', 'Found the job-scout automation in corporate life/job-scout. It reads the daily opportunity brief and prepares applications, but only submits after an explicit "send N". The Supabase Support Engineer listing is still awaiting choose/skip; KoBold is prepared but has conflicting employment dates.', 30, {what:'Found the job-scout automation; it prepares applications but waits for "send N"', stop:'Supabase listing still needs your choose/skip', state:'stopped'}],
  [area.id, 'agent:Meeseeks Prime', 'Three of the five active listings look worth applying to now: Supabase (best skills match), Sticker Mule (a stretch), and the Centre for Effective Altruism (deadline October 22, weaker fit). The two Micro1 roles need official details checked first because key terms conflict.\n\nNo applications were submitted.', 26, {what:'Reviewed five listings — Supabase, Sticker Mule and CEA worth applying to', stop:'Micro1 terms conflict; needs checking first', state:'info'}],
  [application.id, 'agent:Meeseeks Prime II', 'Supabase is still open and looks like a match, but **the application was not submitted**. The form needs your passport country and confirmation you are over 18, a "Why Supabase?" answer, a resume choice, and a vacancy-source option (ChatGPT is not listed).', 24, {what:'Opened the Supabase form — still open and a good match', stop:'Needs passport country, motivation and a vacancy source', state:'stopped'}],
  [application.id, 'agent:Meeseeks Prime II', 'Supabase was **not submitted**. The PC entered Modern Standby and Chrome froze; someone needs to wake it physically before Prime II can continue. He used the confirmed September 2024 start date and drafted the motivation.', 23, {what:'Drafted the motivation and fixed the September 2024 start date', stop:'PC went into standby and Chrome froze', state:'stopped'}],
  [application.id, 'Philip', 'Passport country is Namibia, found it through ChatGPT.', 22, {what:'You confirmed Namibia as passport country and ChatGPT as the source', stop:null, state:'info'}],
  [application.id, 'agent:Meeseeks Prime II', 'Supabase still has not been submitted. Prime II tried again, but Chrome stopped responding while the PC was awake but locked, so he stopped without submitting or touching the other applications.', 2, undefined],
];
for (const [streamId, source, text, hoursAgo, brief] of sample) {
  const e = appendEvent(workState,{streamId,kind:source.startsWith('agent:')?'result':'update',text,source,certainty:'reported'});
  e.at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  if (brief) e.brief = brief;
}
Object.assign(application, {status:'waiting', where:'Form is filled except the vacancy-source field, which has no truthful option.', next:'Ask Supabase how to answer the source field, then submit', blocked:'Source field has no ChatGPT/Other option', owner:'Philip'});
const previewWorkStore = {readState:async()=>structuredClone(workState),mutate:async <T>(fn:(s:typeof workState)=>T)=>{const draft=structuredClone(workState);const result=fn(draft);draft.revision++;workState=draft;return result;}};
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

const emit = (e: unknown) => { for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`); };

/** Turns in flight, mirrored from src/web/bus.ts so /events can send `sync`. */
type Live = { id: string; source: string; startedAt: number; label?: string; tool?: string };
const live = new Map<string, Live>();
let turnSeq = 0;
function startTurn(source: string) {
  const t: Live = { id: `t${++turnSeq}`, source, startedAt: Date.now() };
  live.set(t.id, t);
  emit({ type: 'turn', phase: 'start', id: t.id, source, startedAt: t.startedAt });
  return {
    step(label: string, tool: string) {
      Object.assign(t, { label, tool });
      emit({ type: 'step', label, tool, turn: t.id });
    },
    end() {
      live.delete(t.id);
      emit({ type: 'turn', phase: 'end', id: t.id, source, startedAt: t.startedAt });
    },
  };
}

/**
 * Background turns, for the rail's other paths. "bg" is a reflection that
 * says nothing (its rail should leave no trace); "pc" is a crew report that
 * streams PC chips with no turn id of their own.
 */
async function backgroundTurn(kind: string): Promise<void> {
  if (kind === 'bg') {
    const t = startTurn('reflection');
    await sleep(900);
    t.step('writing in my journal', 'write_journal');
    await sleep(1400);
    t.end();
    return;
  }
  const t = startTurn('inbound:crew');
  for (const what of ['opening cart.ts', 'running the test suite', 'tests passed (42)', 'committing']) {
    await sleep(800);
    emit({ type: 'step', label: `Can-Do Meeseeks: ${what}`, tool: 'pc_session' });
  }
  await sleep(600);
  emit({ type: 'message', role: 'agent', content: 'the crew finished the cart fix — tests are green.', ts: new Date().toISOString(), source: 'inbound:crew' });
  t.end();
}

/** A scripted turn, so every live state (steps, cards, media) can be seen. */
async function fakeTurn(text: string): Promise<void> {
  if (text === 'bg' || text === 'pc') return backgroundTurn(text);
  const t = startTurn('inbound:web');
  emit({ type: 'message', role: 'user', content: text, ts: new Date().toISOString() });
  await sleep(700);
  t.step('consulting my memory', 'recall_facts');
  // A burst, the way parallel tool calls actually land — the rail should hold
  // each readable step rather than strobe through all three.
  await sleep(1100);
  t.step('looking through the drive', 'list_drive_files');
  await sleep(40);
  t.step('reading a file', 'read_drive_file');
  await sleep(40);
  t.step('searching the web', 'web_search');
  await sleep(2600);
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
  await sleep(600);

  // A fenced block — the copy-button case, and the shape a generated prompt
  // actually arrives in.
  emit({
    type: 'message',
    role: 'agent',
    content:
      'and here\'s the prompt you asked for, ready to paste:\n\n' +
      '```text\n' +
      'You are a senior editor. Take the draft below and cut it by 30%\n' +
      'without losing a single concrete detail. Keep the author\'s voice.\n' +
      'Return only the edited draft.\n' +
      '```\n\n' +
      'i also wrote the week up properly — both formats below.',
    ts: new Date().toISOString(),
    source: 'inbound:web',
  });

  // Real generated files through the real file store, so downloads can be
  // tested here rather than only in production.
  const docBody = [
    '# The week',
    '',
    'Sleep is the one metric **actually moving**. The gym number is flat.',
    '',
    '## What moved',
    '- average sleep up to 6.4h (+0.8)',
    '- best stretch since the surgery',
    '',
    '## Still open',
    '1. Welwitch admission-letter fix',
    '2. invoice follow-up, 21 days out',
    '',
    '> Not stuck — batching.',
  ].join('\n');

  const pdf = await generatePdf('The week', docBody);
  if (pdf.ok && pdf.buffer) {
    const id = putFile('the_week.pdf', 'application/pdf', pdf.buffer);
    emit({
      type: 'media', kind: 'document', url: `/files/${id}`,
      filename: 'the_week.pdf', mime: 'application/pdf', bytes: pdf.buffer.length,
    });
  }
  const md = generateMarkdown('The week', docBody);
  if (md.ok && md.buffer) {
    const id = putFile('the_week.md', 'text/markdown', md.buffer);
    emit({
      type: 'media', kind: 'document', url: `/files/${id}`,
      filename: 'the_week.md', mime: 'text/markdown', bytes: md.buffer.length,
    });
  }

  await sleep(400);
  t.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const authed = (bearer || url.searchParams.get('t') || '') === TOKEN;

  if (path === '/workstreams' || path === '/workstreams.js') {
    res.writeHead(200, {'Content-Type':path.endsWith('.js')?'application/javascript':'text/html'});
    res.end(readFileSync(join(WEB,path.endsWith('.js')?'workstreams.js':'workstreams.html')));return;
  }
  if (path === '/api/workstreams') {
    if(!authed){res.writeHead(401).end();return;}
    await workstreamApi(req,res,previewWorkStore);return;
  }
  if (path === '/events') {
    if (!authed) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'sync', turns: [...live.values()] })}\n\n`);
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

  // ── PC sessions: one canned job per state, so every card can be looked at ──
  if (path.startsWith('/pc/')) {
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    const now = Date.now();
    const m = 60_000;
    const job = (id: string, project: string, phase: string, status: string, extra: Record<string, unknown> = {}) => ({
      id, project, task: 'Fix the checkout total rounding', phase, status, createdAt: now - 20 * m, updatedAt: now - 2 * m,
      recent: [], hasShot: false, shotMissing: false, ...extra,
    });
    if (path === '/pc/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        online: true, lastSeenAt: now, modes: [{ id: 'meeseeks', label: 'Meeseeks' }, { id: 'persistent', label: 'Meeseeks Prime' }], projects: ['solarize', 'the-keeper'],
        limits: { queueMin: 10, lostContactMin: 5, maxRunMin: 120 },
        primes: { used: 2, limit: 3, free: 1 },
        approvals: [{ id: 'ap1', jobId: 'w1', tool: 'Bash', summary: 'Run: npm install left-pad', at: now - m }],
        jobs: [
          // The crew: Prime up and running, two workers it named, one that died.
          job('pr1', 'the-keeper', 'running', 'running', { name: 'Meeseeks Prime', role: 'prime', engine: 'codex', model: 'gpt-6.1-sol', mode: 'persistent', modeLabel: 'Meeseeks Prime',
            brief: 'Test SitePMS end to end through the frontend and report every bug', task: 'Test SitePMS end to end through the frontend and report every bug',
            recent: [{ at: now, kind: 'step', text: 'using keeper_crew wait_for_crew' }] }),
          // A second Prime on its own goal, idle between asks (two of three slots used).
          job('pr2', 'solarize', 'idle', 'idle', { name: 'Meeseeks Prime II', role: 'prime', engine: 'codex', model: 'gpt-6.1-sol', mode: 'persistent', modeLabel: 'Meeseeks Prime',
            brief: 'Compare three solar inverter suppliers on price and lead time', task: 'Compare three solar inverter suppliers on price and lead time', result: 'Shortlist ready; waiting for your pick.' }),
          job('cw1', 'sitepms', 'running', 'running', { name: 'Supervisor Rick', role: 'worker', parentId: 'pr1', engine: 'claude', brief: 'Fill in agreements and approve them as the supervisor',
            recent: [{ at: now, kind: 'step', text: 'opening sitepms.vercel.app/agreements' }] }),
          job('cw2', 'sitepms', 'running', 'running', { name: 'Rule-Breaker Meeseeks', role: 'worker', parentId: 'pr1', engine: 'claude', brief: 'Try to break the check-in and assessment rules as Selma (HR)' }),
          job('cw3', 'sitepms', 'failed', 'failed', { name: 'Doofus Rick', role: 'worker', parentId: 'pr1', engine: 'codex', brief: 'Check the mobile layout on the desktop browser',
            recent: [{ at: now, kind: 'error', text: 'Codex exited with code 1' }] }),
          job('w1', 'solarize', 'waiting', 'waiting', { name: 'Can-Do Meeseeks', role: 'solo', engine: 'claude', recent: [{ at: now, kind: 'step', text: 'installing a package' }] }),
          job('q1', 'the-keeper', 'queued', 'queued'),
          job('p1', 'solarize', 'idle', 'idle', { mode: 'persistent', modeLabel: 'Meeseeks Prime', result: 'Fixed the rounding; waiting for what is next.' }),
          job('r1', 'solarize', 'running', 'running', { recent: [{ at: now, kind: 'step', text: 'editing cart.ts' }] }),
          job('d1', 'solarize', 'done', 'done', { result: 'Rounded totals to cents; tests pass.', costUsd: 0.42, hasShot: true, shotUrl: '/icons/galaxy-backdrop.png', shotCaption: 'screen when it finished' }),
          job('d2', 'the-keeper', 'done', 'done', { result: 'Renamed the helper; typecheck clean.', shotMissing: true }),
          job('t1', 'solarize', 'timed_out', 'stopped', { recent: [{ at: now, kind: 'step', text: 'running the full test suite' }] }),
          job('l1', 'the-keeper', 'lost', 'failed', { recent: [{ at: now, kind: 'step', text: 'opening antares.com' }] }),
          job('n1', 'solarize', 'not_picked_up', 'failed'),
          job('f1', 'the-keeper', 'failed', 'failed', { recent: [{ at: now, kind: 'error', text: 'Claude exited: out of credits' }] }),
        ],
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
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

  // Dictation. Real transcription when OPENAI_API_KEY is in the shell's env
  // (it costs $0.003/min); otherwise a canned line, so the states can be seen.
  if (path === '/api/dictate' && req.method === 'POST') {
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const audio = Buffer.concat(chunks);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    console.log(`  dictation: ${(audio.length / 1024).toFixed(0)} KB of ${req.headers['content-type']}`);
    if (!process.env.OPENAI_API_KEY) {
      await sleep(1200);
      reply(200, { ok: true, text: 'remind me to send the Welwitch invoice tomorrow morning' });
      return;
    }
    try {
      const text = await transcribe({ apiKey: process.env.OPENAI_API_KEY, audio, contentType: req.headers['content-type'] });
      reply(200, { ok: true, text });
    } catch (err) {
      reply(err instanceof DictationError ? err.status : 500, { ok: false, error: (err as Error).message });
    }
    return;
  }

  // Read-aloud. Real speech when OPENAI_API_KEY is in the shell's env (about
  // $0.015/min); otherwise a short tone, so the button's states can be seen.
  if (path === '/api/speak' && req.method === 'POST') {
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let text = '';
    try { text = String(JSON.parse(Buffer.concat(chunks).toString('utf-8')).text ?? ''); } catch { /* empty */ }
    console.log(`  read-aloud: ${text.length} chars`);
    if (!process.env.OPENAI_API_KEY) {
      await sleep(900);
      res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(toneWav(1.6));
      return;
    }
    try {
      const audio = await synthesize({ apiKey: process.env.OPENAI_API_KEY, text });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(audio);
    } catch (err) {
      res.writeHead(err instanceof SpeechError ? err.status : 500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
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

  // Generated files, served exactly as src/web/server.ts serves them.
  if (path.startsWith('/files/')) {
    if (!authed) { res.writeHead(401).end(); return; }
    const hit = getFile(decodeURIComponent(path.slice('/files/'.length)));
    if (!hit) { res.writeHead(404).end('gone'); return; }
    res.writeHead(200, {
      'Content-Type': hit.mime,
      'Content-Length': String(hit.buffer.length),
      'Content-Disposition': 'attachment; filename="' + safeFilename(hit.filename) + '"',
    });
    res.end(hit.buffer);
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
