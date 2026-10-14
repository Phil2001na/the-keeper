// Delivery rules of the PC bridge: every session ends in a message to him.
// Run with `npm test`. No network, no Telegram, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.REMOTE_BROWSER_TOKEN = 'test-token';
const pc = await import('../src/web/pcBridge.js');
type PcEvent = import('../src/web/pcBridge.js').PcEvent;

const MIN = 60_000;
const seen: PcEvent[] = [];
pc.pcEvents.on('event', (e: PcEvent) => seen.push(e));

/** Texts of the endings (done / error) announced for one job. */
const endings = (jobId: string) =>
  seen.flatMap((e) => (e.type === 'job' && e.job.id === jobId && (e.event.kind === 'done' || e.event.kind === 'error') ? [`${e.event.kind}: ${e.event.text}`] : []));

function queue(task = 'do the thing') {
  pc.notePoll({ projects: ['sandbox'], running: [] });
  const r = pc.startJob('sandbox', task);
  assert.ok(r.ok);
  return r.job;
}

test('a finished session is announced once, even when the agent retries the same event', () => {
  const job = queue();
  assert.equal(pc.onAgentEvent({ jobId: job.id, kind: 'started', eid: 'a1' }), null);
  assert.equal(pc.onAgentEvent({ jobId: job.id, kind: 'done', eid: 'a2', text: 'all good' }), null);
  assert.equal(pc.onAgentEvent({ jobId: job.id, kind: 'done', eid: 'a2', text: 'all good' }), null);
  assert.deepEqual(endings(job.id), ['done: all good']);
  assert.equal(job.status, 'done');
});

test('a job the PC never picks up is reported as not done', () => {
  const job = queue();
  pc.sweepPcJobs(Date.now() + 5 * MIN);
  assert.deepEqual(endings(job.id), []);
  pc.sweepPcJobs(Date.now() + 11 * MIN);
  assert.equal(job.status, 'failed');
  assert.match(endings(job.id)[0]!, /never picked this up/);
  pc.sweepPcJobs(Date.now() + 30 * MIN);
  assert.equal(endings(job.id).length, 1, 'reported once, not on every sweep');
});

test('a session whose PC goes quiet is reported, and its late result is still delivered', () => {
  const job = queue();
  pc.onAgentEvent({ jobId: job.id, kind: 'started' });
  pc.onAgentEvent({ jobId: job.id, kind: 'step', text: 'opening antares.com' });
  pc.sweepPcJobs(Date.now() + 6 * MIN);
  assert.equal(job.status, 'failed');
  assert.match(endings(job.id)[0]!, /Lost contact.*opening antares\.com/);

  pc.onAgentEvent({ jobId: job.id, kind: 'done', eid: 'late', text: 'here it is' });
  assert.equal(job.status, 'done');
  assert.equal(endings(job.id)[1], 'done: here it is');
});

test('a session the PC keeps vouching for is not reported as lost', () => {
  const job = queue();
  pc.onAgentEvent({ jobId: job.id, kind: 'started' });
  const later = Date.now() + 30 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [{ id: job.id, project: 'sandbox', task: 't' }] }, later);
  pc.sweepPcJobs(later + MIN);
  assert.equal(job.status, 'running');
  assert.deepEqual(endings(job.id), []);
  pc.onAgentEvent({ jobId: job.id, kind: 'done', text: 'ok' });
});

test('a session past the time limit is stopped and reported as unfinished', () => {
  const job = queue();
  pc.onAgentEvent({ jobId: job.id, kind: 'started' });
  pc.onAgentEvent({ jobId: job.id, kind: 'step', text: 'running: npm test' });
  const later = Date.now() + 121 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [job.id] }, later);
  pc.sweepPcJobs(later);
  assert.equal(job.stopReason, 'timeout');
  // The agent aborts and reports the stop in its own words; the relay says why.
  pc.onAgentEvent({ jobId: job.id, kind: 'error', stopped: true, text: 'Stopped from the phone.' });
  assert.equal(job.status, 'stopped');
  assert.match(endings(job.id)[0]!, /120-minute limit.*running: npm test/);
});

test('after a relay restart, a running session and its open approval are taken back', () => {
  const before = seen.length;
  pc.notePoll({
    projects: ['sandbox'],
    running: [{ id: 'feedc0de', project: 'sandbox', task: 'long task', approvals: [{ approvalId: 'ap-1', tool: 'Bash', text: 'Run a command: rm x' }] }],
  });
  const job = pc.getJob('feedc0de');
  assert.ok(job);
  assert.equal(job.status, 'waiting');
  const asked = seen.slice(before).filter((e) => e.type === 'approval');
  assert.equal(asked.length, 1, 'he is asked again, never auto-approved');

  // The same poll again must not ask twice, and neither must a poll after he answered.
  pc.notePoll({ projects: ['sandbox'], running: [{ id: 'feedc0de', project: 'sandbox', task: 'long task', approvals: [{ approvalId: 'ap-1', tool: 'Bash', text: 'x' }] }] });
  assert.equal(pc.decide('ap-1', false), true);
  pc.notePoll({ projects: ['sandbox'], running: [{ id: 'feedc0de', project: 'sandbox', task: 'long task', approvals: [{ approvalId: 'ap-1', tool: 'Bash', text: 'x' }] }] });
  assert.equal(seen.slice(before).filter((e) => e.type === 'approval').length, 1);
  pc.onAgentEvent({ jobId: 'feedc0de', kind: 'done', text: 'ok' });
});

test('a result for a session the relay forgot is still delivered', () => {
  assert.equal(pc.onAgentEvent({ jobId: 'abad1dea', kind: 'done', eid: 'r1', project: 'sandbox', task: 'x', text: 'finished while you were restarting' }), null);
  assert.deepEqual(endings('abad1dea'), ['done: finished while you were restarting']);
  // Without a project there is nothing to report it under.
  assert.equal(pc.onAgentEvent({ jobId: 'deadbeef', kind: 'done', text: 'x' }), 'unknown job');
  // Progress for an unknown session is not adopted from a bare event.
  assert.equal(pc.onAgentEvent({ jobId: 'cafecafe', kind: 'step', project: 'sandbox', text: 'x' }), 'unknown job');
});

test('an agent that only sends ids (older build) keeps the old rule: unknown sessions are stopped', () => {
  pc.notePoll({ projects: ['sandbox'], running: ['0ldag3nt'] });
  assert.equal(pc.getJob('0ldag3nt'), null);
});

test('an approval nobody answers expires as a denial', () => {
  const job = queue();
  pc.onAgentEvent({ jobId: job.id, kind: 'started' });
  pc.onAgentEvent({ jobId: job.id, kind: 'approval', approvalId: 'ap-exp', tool: 'Bash', text: 'Run a command: x' });
  assert.equal(job.status, 'waiting');
  const later = Date.now() + 31 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [job.id] }, later);
  pc.sweepPcJobs(later);
  assert.equal(job.status, 'running');
  assert.ok(seen.some((e) => e.type === 'approval_closed' && e.approvalId === 'ap-exp' && e.allow === false));
  pc.onAgentEvent({ jobId: job.id, kind: 'done', text: 'ok' });
});

test('the phone sees which kind of ending a job had, and why a screenshot is missing', () => {
  // never picked up
  const idle = queue();
  pc.sweepPcJobs(Date.now() + 11 * MIN);
  assert.equal(pc.jobSummary(idle).phase, 'not_picked_up');

  // lost contact, then it comes back
  const lost = queue();
  pc.onAgentEvent({ jobId: lost.id, kind: 'started' });
  pc.sweepPcJobs(Date.now() + 6 * MIN);
  assert.equal(pc.jobSummary(lost).phase, 'lost');
  pc.onAgentEvent({ jobId: lost.id, kind: 'done', text: 'back' });
  assert.equal(pc.jobSummary(lost).phase, 'done');

  // timed out: the relay asked for the stop, the PC confirmed it
  const slow = queue();
  pc.onAgentEvent({ jobId: slow.id, kind: 'started' });
  const later = Date.now() + 121 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [slow.id] }, later); // the PC still vouches for it
  pc.sweepPcJobs(later);
  pc.onAgentEvent({ jobId: slow.id, kind: 'error', stopped: true, text: 'stopped' });
  assert.equal(pc.jobSummary(slow).phase, 'timed_out');

  // done with the locked-PC note: the note moves out of the summary into shotMissing
  const locked = queue();
  pc.onAgentEvent({ jobId: locked.id, kind: 'started' });
  pc.onAgentEvent({ jobId: locked.id, kind: 'done', text: 'fixed it\n\n(No screenshot with this one: the screen could not be captured, which usually means the PC is locked or its display is off.)' });
  const s = pc.jobSummary(locked);
  assert.equal(s.shotMissing, true);
  assert.equal(s.result, 'fixed it');

  // done with a screenshot: a URL, no missing flag
  const shot = queue();
  pc.onAgentEvent({ jobId: shot.id, kind: 'started' });
  pc.onAgentEvent({ jobId: shot.id, kind: 'screenshot', b64: Buffer.from('x').toString('base64'), text: 'screen' });
  pc.onAgentEvent({ jobId: shot.id, kind: 'done', text: 'ok' });
  const t = pc.jobSummary(shot);
  assert.match(t.shotUrl ?? '', /^\/pc\/shot\/[a-z0-9-]+-[0-9]+$/);
  assert.equal(t.shotMissing, false);
});

// ─── Session modes: disposable Meeseeks vs persistent ──────────────────────

function persistent(task = 'first task') {
  pc.notePoll({ projects: ['sandbox'], running: [] });
  const r = pc.startJob('sandbox', task, 'persistent');
  assert.ok(r.ok);
  return r.job;
}

test('the default mode is the disposable one, and an unknown mode is refused', () => {
  assert.equal(queue().mode, 'meeseeks');
  assert.equal(pc.parseMode(undefined), 'meeseeks');
  assert.equal(pc.parseMode('persistent'), 'persistent');
  assert.equal(pc.parseMode('forever'), null);
  const bad = pc.startJob('sandbox', 'x', 'forever' as never);
  assert.equal(bad.ok, false);
});

test('a Meeseeks still ends after its one task and cannot be continued', () => {
  const job = queue();
  pc.onAgentEvent({ jobId: job.id, kind: 'started' });
  pc.onAgentEvent({ jobId: job.id, kind: 'done', text: 'finished' });
  assert.equal(job.status, 'done');
  const r = pc.sendToJob(job.id, 'and another thing');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /ends after its one task/);
});

test('a persistent session goes idle after a task, reports it once, and takes a follow-up', () => {
  const job = persistent();
  pc.onAgentEvent({ jobId: job.id, kind: 'started', sessionId: 's1' });
  assert.equal(pc.sendToJob(job.id, 'too early').ok, false, 'busy sessions refuse a follow-up');
  pc.onAgentEvent({ jobId: job.id, kind: 'turn_done', eid: 't1', text: 'task one done', sessionId: 's1' });
  pc.onAgentEvent({ jobId: job.id, kind: 'turn_done', eid: 't1', text: 'task one done', sessionId: 's1' });
  assert.equal(job.status, 'idle');
  assert.equal(pc.jobSummary(job).phase, 'idle');
  assert.equal(pc.jobSummary(job).modeLabel, pc.MODE_LABELS.persistent);
  assert.equal(job.turns, 1, 'a retried ending is not counted twice');

  // idle sessions are not "lost" while the PC lists them, and not stopped by the run cap
  const later = Date.now() + 30 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [], idle: [{ id: job.id, project: 'sandbox', task: 't' }] }, later);
  pc.sweepPcJobs(later + MIN);
  assert.equal(job.status, 'idle');

  const r = pc.sendToJob(job.id, 'second task');
  assert.ok(r.ok);
  assert.equal(job.status, 'running');
  pc.onAgentEvent({ jobId: job.id, kind: 'turn_done', eid: 't2', text: 'task two done' });
  assert.equal(job.status, 'idle');
  assert.equal(job.turns, 2);

  // ending it says so
  const before = endings(job.id).length;
  assert.equal(pc.stopJob(job.id), true);
  assert.equal(job.status, 'stopped');
  assert.equal(endings(job.id).length, before + 1);
  assert.match(endings(job.id).at(-1)!, /Session closed/);
  assert.equal(pc.sendToJob(job.id, 'after close').ok, false);
});

test('a persistent session that goes quiet while idle is reported, and one left idle too long is closed', () => {
  const quiet = persistent();
  pc.onAgentEvent({ jobId: quiet.id, kind: 'turn_done', text: 'ok' });
  pc.sweepPcJobs(Date.now() + 6 * MIN);
  assert.equal(quiet.status, 'failed');
  assert.equal(pc.jobSummary(quiet).phase, 'lost');
  assert.match(endings(quiet.id).at(-1)!, /Lost contact/);

  const old = persistent();
  pc.onAgentEvent({ jobId: old.id, kind: 'turn_done', text: 'ok' });
  const later = Date.now() + 9 * 60 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [], idle: [{ id: old.id, project: 'sandbox', task: 't' }] }, later);
  pc.sweepPcJobs(later);
  assert.equal(old.status, 'stopped');
  assert.match(endings(old.id).at(-1)!, /closed after 480 minutes/);
});

test('a persistent session keeps the approval and time-cap rules for every task', () => {
  const job = persistent();
  pc.onAgentEvent({ jobId: job.id, kind: 'turn_done', text: 'one' });
  assert.ok(pc.sendToJob(job.id, 'two').ok);
  pc.onAgentEvent({ jobId: job.id, kind: 'approval', approvalId: 'ap-p1', tool: 'Bash', text: 'Run a command: x' });
  assert.equal(job.status, 'waiting', 'a follow-up still asks him before anything risky');
  assert.equal(pc.decide('ap-p1', false), true);
  // the cap counts from this task, not from when the session was created
  const later = Date.now() + 121 * MIN;
  pc.notePoll({ projects: ['sandbox'], running: [job.id] }, later);
  pc.sweepPcJobs(later);
  assert.equal(job.stopReason, 'timeout');
  pc.onAgentEvent({ jobId: job.id, kind: 'error', stopped: true, text: 'stopped' });
  assert.equal(job.status, 'stopped');
});

test('a persistent session is taken back after a relay restart, and a follow-up lost in transit is handed out again', () => {
  pc.notePoll({ projects: ['sandbox'], running: [], idle: [{ id: 'beefbeef', project: 'sandbox', task: 'earlier' }] });
  const job = pc.getJob('beefbeef');
  assert.ok(job);
  assert.equal(job.status, 'idle');
  assert.equal(job.mode, 'persistent');

  assert.ok(pc.sendToJob('beefbeef', 'next').ok);
  job.followup!.handedAt = Date.now() - 60_000; // handed to a dead socket
  pc.notePoll({ projects: ['sandbox'], running: [], idle: [{ id: 'beefbeef', project: 'sandbox', task: 'earlier' }] });
  assert.equal(job.followup?.handedAt, undefined, 'queued again for the next poll');
  pc.onAgentEvent({ jobId: 'beefbeef', kind: 'turn_done', text: 'ok' });
});
