// Real agent + HTTP relay + fake engine: no credentials or external mutations.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
process.env.REMOTE_BROWSER_TOKEN = 'isolated-approval-test';
const pc = await import('../src/web/pcBridge.js');
const state = mkdtempSync(join(tmpdir(), 'keeper-approval-e2e-'));
writeFileSync(join(state, 'projects.json'), JSON.stringify({ projects: { sandbox: { path: state } }, codexJs: resolve('test/fixtures/approval-engine.mjs'), screenshotOnFinish: false }));
const server = createServer((req, res) => {
  if (!pc.handlePcBridge(req, res, new URL(req.url!, 'http://local').pathname, true)) res.writeHead(404).end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const child = spawn(process.execPath, [resolve('pc-agent/agent.mjs')], {
  env: { ...process.env, KEEPER_URL: `http://127.0.0.1:${port}`, PC_AGENT_STATE: state, PC_AGENT_CONFIG: join(state, 'projects.json') },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', b => output += b.toString());
child.stderr.on('data', b => output += b.toString());
let requests = 0;
let queued = false;
let settle!: () => void;
let fail!: (e: Error) => void;
const done = new Promise<void>((yes, no) => { settle = yes; fail = no; });
pc.pcEvents.on('event', e => {
  try {
    if (e.type === 'approval') {
      requests++;
      assert.equal(e.job.status, 'waiting');
      assert.match(e.approval.summary, /This call only/);
      assert.match(e.approval.summary, /SIMULATED recipient/);
      // These choices are test-only responses for tools that cannot execute.
      if (requests === 1) pc.decide(e.approval.id, false);
      else if (requests === 2) pc.decide(e.approval.id, true);
      else if (requests === 3) {
        const clock = Date.now;
        try { Date.now = () => clock() + 31 * 60_000; pc.openApprovals(); }
        finally { Date.now = clock; }
      } else pc.decide(e.approval.id, false);
    }
    if (e.type === 'job' && e.event.kind === 'done') {
      assert.equal(requests, 4, 'three spending actions and the EDU production action ask');
      assert.deepEqual(JSON.parse(e.event.text!), [
        { tool: 'take_snapshot', action: 'accept' },
        { tool: 'submit_application', action: 'accept' },
        { tool: 'send_email', action: 'accept' },
        { tool: 'purchase', action: 'decline' },
        { tool: 'delete_file', action: 'accept' },
        { tool: 'change_security_settings', action: 'accept' },
        { tool: 'subscription', action: 'accept' },
        { tool: 'paid_booking', action: 'decline' },
        { tool: 'edu_production_action', action: 'decline' },
      ]);
      settle();
    }
    if (e.type === 'job' && e.event.kind === 'error') fail(new Error(e.event.text));
  } catch (err) { fail(err as Error); }
});
const poll = setInterval(() => {
  if (queued) return;
  const result = pc.startJob('sandbox', 'Exercise simulated approvals only.', 'meeseeks', { engine: 'codex' });
  if (result.ok) queued = true;
}, 100);
const deadline = setTimeout(() => fail(new Error(`E2E timeout: ${output.slice(-2000)}`)), 90_000);
try {
  await done;
  console.log('PASS: non-spending calls silent; purchase denied; subscription approved once; paid booking expired/denied; cross-project EDU production action denied. All actions simulated.');
} finally {
  clearInterval(poll); clearTimeout(deadline); child.kill(); server.closeAllConnections(); server.close();
}
