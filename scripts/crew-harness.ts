// Local end-to-end run of the crew: a real PC agent, a real Prime (Codex by
// default), real workers, against this relay. No Telegram, no DB.
//
//   PRIME_PROJECT=sandbox npx tsx scripts/crew-harness.ts "<goal>"
//   (then start pc-agent with KEEPER_URL=http://localhost:8787 and a PC_AGENT_CONFIG that allows "sandbox")
//
// Approvals are auto-allowed. Exits after Prime's second report (the one it
// writes after being woken by its crew), or after PC_HARNESS_TURNS reports.
import { createServer } from 'node:http';
import { handlePcBridge, pcEvents, decide, delegateToPrime, stopJob, type PcEvent } from '../src/web/pcBridge.js';

const WANT = Number(process.env.PC_HARNESS_TURNS ?? 2);
let primeTurns = 0;
pcEvents.on('event', (e: PcEvent) => {
  if (e.type === 'approval') {
    console.log(`APPROVAL (allowing) ${e.job.name}:`, e.approval.summary.replace(/\n/g, ' | '));
    setTimeout(() => decide(e.approval.id, true), 300);
    return;
  }
  if (e.type !== 'job') return;
  const { job, event } = e;
  console.log(`[${job.role}] ${job.name} ${event.kind} (${job.status}):`, (event.text ?? '').replace(/\n/g, ' | ').slice(0, 400));
  if (job.role === 'prime' && event.kind === 'turn_done' && ++primeTurns >= WANT) {
    setTimeout(() => { stopJob(job.id); setTimeout(() => process.exit(0), 1500); }, 500);
  }
  if (job.role === 'prime' && event.kind === 'error') setTimeout(() => process.exit(1), 500);
});
createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (!handlePcBridge(req, res, path, true)) { res.writeHead(404); res.end(); }
}).listen(8787, () => console.log('crew harness on :8787'));
const goal = process.argv[2] ?? 'say hi';
const iv = setInterval(() => {
  const r = delegateToPrime(goal);
  if (r.ok) { console.log('prime queued', r.job.id, r.job.engine, r.job.model); clearInterval(iv); }
}, 1000);
