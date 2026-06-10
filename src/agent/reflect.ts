import { localDateString } from '../config.js';
import { interactions, journal, touchpoints } from '../db/repositories.js';
import { runAgent } from './orchestrator.js';

/**
 * The agent's nightly reflection — its inner life. Once per evening it wakes
 * privately (no message to Philip), reviews the day, consolidates memory,
 * studies how its proactive reach-outs have been landing, and writes a journal
 * entry that tomorrow's turns read back as continuity of self.
 */
export async function runNightlyReflection(): Promise<void> {
  const day = localDateString();

  const [fired, todayCount] = await Promise.all([
    touchpoints.recentFired(7),
    interactions.countSince(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
  ]);
  const sent = fired.filter((t) => t.outcome === 'sent').length;
  const replied = fired.filter((t) => t.outcome === 'replied').length;
  const stayedSilent = fired.filter((t) => t.outcome === 'silent').length;

  const brief =
    `[INTERNAL — NIGHTLY REFLECTION — Philip will NOT see this. Do NOT write him a message.]\n` +
    `It's the end of ${day}. ${todayCount} messages passed between you in the last 24h (the recent ones are in your context; search_history reaches further back).\n\n` +
    `Tend your memory and your judgement:\n` +
    `1. CONSOLIDATE — remember_fact anything important from today that isn't stored yet; forget_fact anything stale, wrong, or duplicated; update_domain if a sector's description/cadence/priority no longer fits his life (active=false retires one). A small sharp memory beats a big stale one.\n` +
    `2. LEARN YOUR RHYTHM — over the last 7 days you fired ${fired.length} touchpoint(s): ${sent + replied} messaged him, ${replied} of those got a reply, ${stayedSilent} you stayed silent on. If your reach-outs aren't landing, change when and why you reach out — that judgement is your core intelligence.\n` +
    `3. GLANCE AHEAD — you may check list_emails ("is:unread") once to see if anything genuinely important is waiting; factor it into tomorrow, don't act on it now.\n` +
    `4. TEND TOMORROW — make sure at most ONE sensible touchpoint is pending (schedule/cancel as needed), or deliberately none if space serves him better.\n` +
    `5. WRITE — finish with write_journal: a few honest private lines on the state of him, what changed today, and what you're watching. Tomorrow-you reads this.\n\n` +
    `Then use stay_silent. Never message him from a reflection.`;

  await runAgent({ kind: 'reflection', brief });

  // The journal row doubles as the once-per-night guard. If the model somehow
  // ended without writing one, write a stub so reflection doesn't re-run all hour.
  if (!(await journal.hasDay('nightly', day))) {
    await journal.upsert('nightly', day, '(reflection ran but wrote no entry)');
  }
  console.log(`[reflect] nightly reflection complete for ${day}.`);
}

/** True if tonight's reflection hasn't happened yet. */
export async function reflectionPending(): Promise<boolean> {
  return !(await journal.hasDay('nightly', localDateString()));
}
