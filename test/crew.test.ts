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

test('Prime is one at a time, runs on Codex + gpt-6.1-sol, and takes new goals only when idle', () => {
  const prime = upPrime();
  assert.equal(prime.role, 'prime');
  assert.equal(prime.name, 'Meeseeks Prime');
  assert.equal(prime.mode, 'persistent');
  assert.equal(prime.engine, 'codex');
  assert.equal(prime.model, 'gpt-6.1-sol');
  assert.equal(pc.livePrime()?.id, prime.id);

  const busy = pc.delegateToPrime('something else');
  assert.ok(!busy.ok && /busy/.test(busy.error));
  assert.ok(!pc.startJob('the-keeper', 'x', 'persistent', { role: 'prime' }).ok, 'a second Prime is refused');

  pc.onAgentEvent({ jobId: prime.id, kind: 'turn_done', eid: `t-${prime.id}`, text: 'plan made' });
  const next = pc.delegateToPrime('now research the competitors');
  assert.ok(next.ok && !next.started && next.job.id === prime.id);
  assert.equal(prime.brief, 'now research the competitors');
  endPrime(prime);
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
