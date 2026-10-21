// The crew: Meeseeks Prime, the workers it spawns, and who hears what.
// Run with `npm test`. No network, no Telegram, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.REMOTE_BROWSER_TOKEN = 'test-token';
const pc = await import('../src/web/pcBridge.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
pc.notePoll({ projects: ['the-keeper', 'sitepms'], running: [] });

/** Stop Prime the way the PC confirms it: a stop request, then its stopped ending. */
function endPrime(prime: { id: string }) {
  pc.stopJob(prime.id);
  pc.onAgentEvent({ jobId: prime.id, kind: 'error', eid: `end-${prime.id}-${Math.random()}`, stopped: true, text: 'Stopped from the phone.' });
}

function upPrime(goal = 'test SitePMS end to end') {
  const r = pc.delegateToPrime(goal);
  assert.ok(r.ok);
  pc.onAgentEvent({ jobId: r.job.id, kind: 'started', eid: `s-${r.job.id}` });
  return r.job;
}

test('Prime runs on Codex + gpt-6.1-sol, and takes a follow-up by id only when idle', () => {
  const prime = upPrime();
  assert.equal(prime.role, 'prime');
  assert.equal(prime.name, 'Meeseeks Prime');
  assert.equal(prime.mode, 'persistent');
  assert.equal(prime.engine, 'codex');
  assert.equal(prime.model, 'gpt-6.1-sol');
  assert.deepEqual(pc.livePrimes().map((p) => p.id), [prime.id]);

  const busy = pc.delegateToPrime('something else', prime.id);
  assert.ok(!busy.ok && /busy/.test(busy.error));

  pc.onAgentEvent({ jobId: prime.id, kind: 'turn_done', eid: `t-${prime.id}`, text: 'plan made' });
  const next = pc.delegateToPrime('now research the competitors', prime.id);
  assert.ok(next.ok && !next.started && next.job.id === prime.id);
  assert.equal(prime.brief, 'now research the competitors');
  endPrime(prime);
  const gone = pc.delegateToPrime('more', prime.id);
  assert.ok(!gone.ok && /already ended/.test(gone.error));
});

test('only a live Prime spawns workers, names stay unique, and the crew is capped', () => {
  const prime = upPrime();
  assert.equal(pc.crewOp({ op: 'spawn', parentId: 'nope', name: 'x', goal: 'y' }).ok, false);

  const a = pc.crewOp({ op: 'spawn', parentId: prime.id, name: 'Supervisor Rick', goal: 'approve agreements', project: 'sitepms' });
  const b = pc.crewOp({ op: 'spawn', parentId: prime.id, name: 'Supervisor Rick', goal: 'approve more', engine: 'codex' });
  assert.ok(a.ok && b.ok);
  const wa = (a as { worker: { id: string; name: string } }).worker;
  const wb = (b as { worker: { id: string; name: string; engine: string; project: string } }).worker;
  assert.equal(wa.name, 'Supervisor Rick');
  assert.equal(wb.name, 'Supervisor Rick II');
  assert.equal(wb.engine, 'codex');
  assert.equal(wb.project, 'the-keeper', "defaults to Prime's project");

  assert.ok(pc.crewOp({ op: 'spawn', parentId: prime.id, name: 'Third', goal: 'z' }).ok);
  const fourth = pc.crewOp({ op: 'spawn', parentId: prime.id, name: 'Fourth', goal: 'z' });
  assert.ok(!fourth.ok && /limit 3/.test(String(fourth.error)));
  assert.equal(pc.crewOp({ op: 'spawn', parentId: prime.id, name: 'x', goal: 'y', engine: 'gemini' }).ok, false);

  // Prime stopped for good: its crew does not keep running unwatched.
  endPrime(prime);
  return tick().then(() => {
    for (const w of pc.crewOf(prime.id)) assert.notEqual(w.status, 'running');
  });
});

test('when the last worker ends, an idle Prime is woken with the reports, once', async () => {
  const prime = upPrime();
  const sp = (name: string) => (pc.crewOp({ op: 'spawn', parentId: prime.id, name, goal: 'break it' }) as { worker: { id: string } }).worker.id;
  const w1 = sp('Rule-Breaker Meeseeks');
  const w2 = sp('Doofus Rick');
  pc.onAgentEvent({ jobId: prime.id, kind: 'turn_done', eid: `t2-${prime.id}`, text: 'crew is out' });
  await tick();
  assert.equal(prime.status, 'idle');

  pc.onAgentEvent({ jobId: w1, kind: 'done', eid: `d-${w1}`, text: 'found 2 bugs' });
  await tick();
  assert.equal(prime.status, 'idle', 'still one worker out');

  pc.onAgentEvent({ jobId: w2, kind: 'error', eid: `x-${w2}`, text: 'browser crashed' });
  await tick();
  assert.equal(prime.status, 'running');
  assert.match(prime.followup!.text, /found 2 bugs/);
  assert.match(prime.followup!.text, /browser crashed/);
  assert.equal(prime.brief, 'test SitePMS end to end', 'a crew wake-up is not a new ask');

  // Reports are handed over once: the next idle does not wake it again.
  pc.onAgentEvent({ jobId: prime.id, kind: 'turn_done', eid: `t3-${prime.id}`, text: 'final report' });
  await tick();
  assert.equal(prime.status, 'idle');
  endPrime(prime);
});

test('a report reaches him through the Keeper when it is Prime’s or long; workers never directly', () => {
  const prime = upPrime();
  const solo = pc.startJob('sitepms', 'quick fix');
  assert.ok(solo.ok);
  assert.equal(solo.job.role, 'solo');
  assert.match(solo.job.name, /Meeseeks/);
  const w = (pc.crewOp({ op: 'spawn', parentId: prime.id, name: 'Tiny Rick', goal: 'g' }) as { worker: { id: string } }).worker.id;

  assert.equal(pc.relaysThroughKeeper(prime, 'short'), true);
  assert.equal(pc.relaysThroughKeeper(solo.job, 'short'), false);
  assert.equal(pc.relaysThroughKeeper(solo.job, 'x'.repeat(pc.RELAY_OVER_CHARS + 1)), true);
  assert.equal(pc.relaysThroughKeeper(pc.getJob(w)!, 'x'.repeat(5000)), false);

  const s = pc.jobSummary(prime);
  assert.equal(s.online, true);
  assert.equal(s.name, 'Meeseeks Prime');
  endPrime(prime);
});

test('a relay restart takes the crew back with names and roles from the PC', () => {
  pc.notePoll({
    projects: ['the-keeper'],
    running: [{ id: 'adopt-w1', project: 'the-keeper', task: 'go', role: 'worker', name: 'Mr. Poopybutthole', parentId: 'gone', engine: 'codex' }],
    idle: [{ id: 'adopt-p1', project: 'the-keeper', task: 'plan', role: 'prime', engine: 'codex', model: 'gpt-6.1-sol' }],
  });
  const w = pc.getJob('adopt-w1')!;
  assert.equal(w.name, 'Mr. Poopybutthole');
  assert.equal(w.role, 'worker');
  assert.equal(w.engine, 'codex');
  const p = pc.getJob('adopt-p1')!;
  assert.equal(p.role, 'prime');
  assert.equal(p.status, 'idle');
  assert.equal(p.name, 'Meeseeks Prime');
});

test('lessons ride along with every job handed to the PC, and Prime can add one', async () => {
  pc.notePoll({ projects: ['the-keeper', 'sitepms'], running: [] });
  for (const j of pc.listJobs()) if (j.role === 'prime') endPrime(j);
  const added: string[] = [];
  pc.setCrewLessons(['Sign in with his Google session before calling a site locked.'], (t) => added.push(t));
  const prime = upPrime('check lessons');
  assert.equal(pc.crewOp({ op: 'lesson', parentId: prime.id, lesson: 'Never test on the live tenant.' }).ok, true);
  assert.deepEqual(added, ['Never test on the live tenant.']);
  // The poll reply that hands out a queued job carries the lessons.
  const job = pc.startJob('sitepms', 'quick check');
  assert.ok(job.ok);
  const body = await new Promise<Record<string, unknown>>((resolve) => {
    const res = { writeHead() { return res; }, end(b: string) { resolve(JSON.parse(b)); }, on() {} };
    const req = Object.assign(Readable.from([Buffer.from('{"projects":["the-keeper","sitepms"],"running":[]}')]), { method: 'POST', headers: { 'x-agent-token': 'test-token' } });
    pc.handlePcBridge(req as never, res as never, '/pc/agent/poll', false);
  });
  const handed = (body.jobs as Array<{ id: string; lessons: string[] }>).find((j) => j.id === job.job.id);
  assert.deepEqual(handed?.lessons, ['Sign in with his Google session before calling a site locked.']);
  endPrime(prime);
});

/** End every Prime still holding a slot, so each test starts from none. */
function clearPrimes() {
  for (const j of pc.listJobs()) if (j.role === 'prime' && (['queued', 'running', 'waiting', 'idle'].includes(j.status) || j.lost)) endPrime(j);
  assert.equal(pc.primeSlots().used, 0);
}

test('up to three Primes run at once, each named and crewed on its own; a fourth is refused', async () => {
  pc.notePoll({ projects: ['the-keeper', 'sitepms'], running: [] });
  clearPrimes();
  assert.equal(pc.MAX_PRIMES, 3);
  const a = upPrime('build the invoice page');
  const b = upPrime('research solar suppliers');
  // Still queued (not yet picked up by the PC) holds a slot too.
  const c = pc.delegateToPrime('test SitePMS end to end');
  assert.ok(c.ok && c.started);
  assert.deepEqual([a.name, b.name, c.job.name], ['Meeseeks Prime', 'Meeseeks Prime II', 'Meeseeks Prime III']);
  assert.deepEqual(pc.primeSlots(), { used: 3, limit: 3, free: 0 });

  const fourth = pc.delegateToPrime('one more big thing');
  assert.ok(!fourth.ok);
  assert.match(fourth.error, /All 3 Meeseeks Primes are already up/);
  assert.match(fourth.error, /research solar suppliers/, 'says who is on what');
  assert.ok(!pc.startJob('the-keeper', 'x', 'persistent', { role: 'prime' }).ok, 'no back door through startJob');
  assert.equal(pc.livePrimes().length, 3);

  // Regular Meeseeks and each Prime's own crew are untouched by the Prime limit.
  const solo = pc.startJob('sitepms', 'one bounded fix');
  assert.ok(solo.ok && solo.job.role === 'solo' && solo.job.mode === 'meeseeks');
  const wa = pc.crewOp({ op: 'spawn', parentId: a.id, name: 'Tiny Rick', goal: 'g' });
  const wb = pc.crewOp({ op: 'spawn', parentId: b.id, name: 'Tiny Rick', goal: 'g' });
  assert.ok(wa.ok && wb.ok);
  const status = pc.crewOp({ op: 'status', parentId: a.id }) as { workers: { id: string }[] };
  assert.deepEqual(status.workers.map((w) => w.id), [(wa as { worker: { id: string } }).worker.id], 'a Prime sees only its own crew');

  // The relay's state shows the limit.
  const state = await new Promise<Record<string, unknown>>((resolve) => {
    const res = { writeHead() { return res; }, end(x: string) { resolve(JSON.parse(x)); } };
    pc.handlePcBridge({ method: 'GET', headers: {} } as never, res as never, '/pc/state', true);
  });
  assert.deepEqual(state.primes, { used: 3, limit: 3, free: 0 });

  // A slot freed by one ending is usable again, and only once.
  endPrime(b);
  const again = pc.delegateToPrime('one more big thing');
  assert.ok(again.ok && again.started);
  assert.equal(again.job.name, 'Meeseeks Prime II', 'a freed name is reused');
  assert.ok(!pc.delegateToPrime('and another').ok);
  pc.stopJob(solo.job.id);
  clearPrimes();
});

test('a Prime that lost contact keeps its slot until it is back or let go', () => {
  clearPrimes();
  const a = upPrime('a');
  upPrime('b');
  upPrime('c');
  // The PC goes quiet: every Prime is reported lost, but none of their slots are free.
  pc.sweepPcJobs(Date.now() + 6 * 60_000);
  assert.equal(a.lost, true);
  assert.equal(pc.livePrimes().length, 0);
  assert.equal(pc.primeSlots().used, 3);
  assert.ok(!pc.delegateToPrime('d').ok, 'a fourth cannot slip in while they may come back');

  // Letting one go frees its slot, and the PC is told to stop it if it reappears.
  assert.equal(pc.stopJob(a.id), true);
  assert.equal(a.status, 'stopped');
  assert.equal(pc.primeSlots().used, 2);
  const d = pc.delegateToPrime('d');
  assert.ok(d.ok);
  clearPrimes();
});

test('a relay restart adopts several Primes under their own names', () => {
  clearPrimes();
  pc.notePoll({
    projects: ['the-keeper'],
    running: [],
    idle: [
      { id: 'adopt-p2', project: 'the-keeper', task: 'x', role: 'prime', name: 'Meeseeks Prime', engine: 'codex' },
      { id: 'adopt-p3', project: 'the-keeper', task: 'y', role: 'prime', name: 'Meeseeks Prime II', engine: 'codex' },
    ],
  });
  assert.deepEqual(['adopt-p2', 'adopt-p3'].map((id) => pc.getJob(id)!.name), ['Meeseeks Prime', 'Meeseeks Prime II']);
  assert.equal(pc.primeSlots().used, 2);
  const third = pc.delegateToPrime('z');
  assert.ok(third.ok && third.job.name === 'Meeseeks Prime III');
  clearPrimes();
});

/** One request through the real route handler, as the phone sends it. */
function call(path: string, body: unknown, authed = true): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = { writeHead(s: number) { status = s; return res; }, end(b: string) { resolve({ status, body: JSON.parse(b) }); }, on() {} };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: authed ? {} : { 'x-agent-token': 'test-token' } });
    pc.handlePcBridge(req as never, res as never, path, authed);
  });
}

/** The jobs the PC is handed on its next poll. */
async function handedOut(): Promise<Array<{ id: string; role: string; engine: string; model?: string }>> {
  const r = await call('/pc/agent/poll', { projects: ['the-keeper', 'sitepms'], running: [] }, false);
  return r.body.jobs as Array<{ id: string; role: string; engine: string; model?: string }>;
}

test('the engine he picks at launch is the one the PC is told to run, for a Prime and a Meeseeks', async () => {
  clearPrimes();
  await handedOut(); // drain anything earlier tests queued

  // Meeseeks Prime on Claude: no Codex model rides along with it.
  const claudePrime = await call('/pc/delegate', { goal: 'plan the launch', engine: 'claude' });
  assert.equal(claudePrime.status, 200);
  const cp = claudePrime.body.job as { id: string; engine: string; role: string; model?: string };
  assert.equal(cp.role, 'prime');
  assert.equal(cp.engine, 'claude');
  assert.equal(cp.model, undefined);

  // Meeseeks Prime on Codex keeps the Codex model.
  const codexPrime = await call('/pc/delegate', { goal: 'drive the desktop app', engine: 'codex' });
  const xp = codexPrime.body.job as { id: string; engine: string; model?: string };
  assert.equal(xp.engine, 'codex');
  assert.equal(xp.model, 'gpt-6.1-sol');

  // A one-job Meeseeks, each way.
  const solo = (await call('/pc/start', { project: 'sitepms', task: 'one fix', mode: 'meeseeks', engine: 'codex' })).body.job as { id: string };
  const solo2 = (await call('/pc/start', { project: 'sitepms', task: 'another fix', mode: 'meeseeks', engine: 'claude' })).body.job as { id: string };

  const jobs = await handedOut();
  const engineOf = (id: string) => jobs.find((j) => j.id === id);
  assert.deepEqual([engineOf(cp.id)?.role, engineOf(cp.id)?.engine, engineOf(cp.id)?.model], ['prime', 'claude', undefined]);
  assert.deepEqual([engineOf(xp.id)?.role, engineOf(xp.id)?.engine, engineOf(xp.id)?.model], ['prime', 'codex', 'gpt-6.1-sol']);
  assert.equal(engineOf(solo.id)?.engine, 'codex');
  assert.equal(engineOf(solo2.id)?.engine, 'claude');

  // An unknown engine starts nothing.
  const bad = await call('/pc/delegate', { goal: 'x', engine: 'gemini' });
  assert.equal(bad.status, 400);
  assert.equal(pc.primeSlots().used, 2);

  // No engine sent (an older page, or the Keeper leaving it out): Prime's own default.
  const plain = await call('/pc/delegate', { goal: 'whatever is default' });
  assert.equal((plain.body.job as { engine: string }).engine, 'codex');

  // A running Prime cannot switch engine mid-context; it says how to get one on the other.
  pc.onAgentEvent({ jobId: cp.id, kind: 'started', eid: `s-${cp.id}` });
  pc.onAgentEvent({ jobId: cp.id, kind: 'turn_done', eid: `t-${cp.id}`, text: 'plan made' });
  const swap = pc.delegateToPrime('now do it', cp.id, 'codex');
  assert.ok(!swap.ok && /runs on claude/.test(swap.error));
  assert.ok(pc.delegateToPrime('now do it', cp.id, 'claude').ok);

  pc.stopJob(solo.id);
  pc.stopJob(solo2.id);
  clearPrimes();
});
