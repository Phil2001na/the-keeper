// Resume only the explicitly selected session after the authorized idle rollout.
// Credentials stay in process memory; no token or response body is logged.
import 'dotenv/config';
const id = process.argv[2];
if (!/^[a-f0-9]{8}$/.test(id ?? '')) throw new Error('Expected selected PC job ID');
const base = (process.env.KEEPER_URL || 'https://the-keeper-production.up.railway.app').replace(/\/$/, '');
const headers = { Authorization: `Bearer ${process.env.KEEPER_WEB_TOKEN || ''}`, 'Content-Type': 'application/json' };
let ready = false;
for (let n = 0; n < 30; n++) {
  const response = await fetch(`${base}/pc/state`, { headers, signal: AbortSignal.timeout(10000) });
  if (response.status === 401 || response.status === 403) throw new Error('Session resume authentication requires review');
  if (response.ok) {
    const state = await response.json();
    if (state.jobs?.some(j => j.id === id && j.status === 'idle')) { ready = true; break; }
  }
  await new Promise(r => setTimeout(r, 2000));
}
if (!ready) throw new Error('Selected session was not restored idle; no follow-up sent');
const response = await fetch(`${base}/pc/send`, { method: 'POST', headers, signal: AbortSignal.timeout(10000),
  body: JSON.stringify({ jobId: id, message: 'Continue the already authorized shared-brain merge/deployment and policy activation task. The idle-only helper finished activation. Verify artifacts/approval-rollout/receipt.json, reviewed file hashes, running PC-agent version, Railway deployed commit/health, and strict EDU simulated test evidence; finish the exact report. Do not perform an EDU production operation. This is an automated continuation of the same authorized task.' }) });
if (!response.ok) throw new Error(`Session follow-up failed (HTTP ${response.status})`);
console.log(`Authorized verification continuation queued for ${id}.`);
