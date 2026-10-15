// Local test relay for the PC bridge: no Telegram, no DB. Auto-approves the first
// permission request and denies the second, printing everything.
import { createServer } from 'node:http';
import { handlePcBridge, pcEvents, decide, startJob, sendToJob, stopJob, parseMode, type PcEvent } from '../src/web/pcBridge.js';

let n = 0;
let endings = 0;
let turns = 0;
const MODE = parseMode(process.env.PC_HARNESS_MODE) ?? 'meeseeks';
const FOLLOWUP = process.env.PC_HARNESS_FOLLOWUP ?? '';
const WANT = Number(process.env.PC_HARNESS_ENDINGS ?? 1);
pcEvents.on('event', (e: PcEvent) => {
  if (e.type === 'approval') {
    n++;
    const allow = n === 1;
    console.log(`APPROVAL #${n} (${allow ? 'allowing' : 'denying'}):`, e.approval.summary.replace(/\n/g, ' | '));
    setTimeout(() => decide(e.approval.id, allow), 500);
  } else if (e.type === 'job') {
    const t = e.event.kind === 'screenshot' ? `[${e.job.shot?.b64.length} b64 chars]` : (e.event.text ?? '').replace(/\n/g, ' | ').slice(0, 300);
    console.log(`EVENT ${e.event.kind} [${e.job.status}]:`, t);
    // PC_HARNESS_ENDINGS=2 waits for a second ending, e.g. an interrupted session reported at agent start.
    // PC_HARNESS_MODE=persistent PC_HARNESS_FOLLOWUP="..." runs one task, sends the follow-up, then closes the session.
    if (e.event.kind === 'turn_done') {
      if (++turns === 1 && FOLLOWUP) setTimeout(() => console.log('follow-up:', JSON.stringify(sendToJob(e.job.id, FOLLOWUP))), 500);
      else setTimeout(() => console.log('close:', stopJob(e.job.id)), 500);
    }
    if ((e.event.kind === 'done' || e.event.kind === 'error') && ++endings >= WANT) setTimeout(() => process.exit(0), 500);
  }
});
createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (!handlePcBridge(req, res, path, true)) { res.writeHead(404); res.end(); }
}).listen(8787, () => console.log('harness on :8787'));
const task = process.argv[2] ?? 'say hi';
const iv = setInterval(() => {
  const r = startJob('sandbox', task, MODE, { engine: process.env.PC_HARNESS_ENGINE === 'codex' ? 'codex' : 'claude' });
  if (r.ok) { console.log('queued', r.job.id); clearInterval(iv); }
}, 1000);
