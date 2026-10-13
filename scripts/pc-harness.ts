// Local test relay for the PC bridge: no Telegram, no DB. Auto-approves the first
// permission request and denies the second, printing everything.
import { createServer } from 'node:http';
import { handlePcBridge, pcEvents, decide, startJob, type PcEvent } from '../src/web/pcBridge.js';

let n = 0;
pcEvents.on('event', (e: PcEvent) => {
  if (e.type === 'approval') {
    n++;
    const allow = n === 1;
    console.log(`APPROVAL #${n} (${allow ? 'allowing' : 'denying'}):`, e.approval.summary.replace(/\n/g, ' | '));
    setTimeout(() => decide(e.approval.id, allow), 500);
  } else if (e.type === 'job') {
    const t = e.event.kind === 'screenshot' ? `[${e.job.shot?.b64.length} b64 chars]` : (e.event.text ?? '').replace(/\n/g, ' | ').slice(0, 300);
    console.log(`EVENT ${e.event.kind} [${e.job.status}]:`, t);
    if (e.event.kind === 'done' || e.event.kind === 'error') setTimeout(() => process.exit(0), 500);
  }
});
createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (!handlePcBridge(req, res, path, true)) { res.writeHead(404); res.end(); }
}).listen(8787, () => console.log('harness on :8787'));
const task = process.argv[2] ?? 'say hi';
const iv = setInterval(() => {
  const r = startJob('sandbox', task);
  if (r.ok) { console.log('queued', r.job.id); clearInterval(iv); }
}, 1000);
