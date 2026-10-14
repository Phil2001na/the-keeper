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
