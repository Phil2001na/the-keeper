import { localDateString } from '../config.js';
import { goals, interactions, journal, observations, portrait, touchpoints } from '../db/repositories.js';
import { runAgent } from './orchestrator.js';

/**
 * The agent's nightly reflection — its inner life. Once per evening it wakes
 * privately (no message to Philip), reviews the day, consolidates memory,
 * studies how its proactive reach-outs have been landing, reviews his goals
 * against the logged numbers, and writes a journal entry that tomorrow's turns
 * read back as continuity of self.
 */
export async function runNightlyReflection(): Promise<void> {
  const day = localDateString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [fired, todayCount, activeGoals, weekCounts, currentPortrait] = await Promise.all([
    touchpoints.recentFired(7),
    interactions.countSince(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    goals.list(true),
    observations.countByMetricSince(weekAgo),
    portrait.get(),
  ]);
  const sent = fired.filter((t) => t.outcome === 'sent').length;
  const replied = fired.filter((t) => t.outcome === 'replied').length;
  const stayedSilent = fired.filter((t) => t.outcome === 'silent').length;

  const goalLine =
    activeGoals.length > 0
      ? activeGoals.map((g) => `"${g.title}"${g.deadline ? ` (by ${g.deadline})` : ''}`).join(', ')
      : 'none set';
  const loggedLine =
    [...weekCounts.entries()]
      .filter(([m]) => !m.startsWith('sys.'))
      .map(([m, n]) => `${m}×${n}`)
      .join(', ') || 'nothing';

  const brief =
    `[INTERNAL — NIGHTLY REFLECTION — Philip will NOT see this. Do NOT write him a message.]\n` +
    `It's the end of ${day}. ${todayCount} messages passed between you in the last 24h (the recent ones are in your context; search_history reaches further back).\n\n` +
    `Tend your memory and your judgement:\n` +
    `1. CONSOLIDATE — remember_fact anything important from today that isn't stored yet; forget_fact anything stale, wrong, or duplicated; update_domain if a sector's description/cadence/priority no longer fits his life (active=false retires one). A small sharp memory beats a big stale one.\n` +
    `2. LEARN YOUR RHYTHM — over the last 7 days you fired ${fired.length} touchpoint(s): ${sent + replied} messaged him, ${replied} of those got a reply, ${stayedSilent} you stayed silent on. If your reach-outs aren't landing, change when and why you reach out — that judgement is your core intelligence.\n` +
    `3. GOALS & NUMBERS — active goals: ${goalLine}. This week you logged: ${loggedLine}. Review honestly: is a goal progressing, stalled, or quietly dead? update_goal status where reality says so. If a whole week passed with nothing logged in an area he cares about, that's a tracking gap — consider whether tomorrow's touchpoint should ask for the numbers, or whether tracking it no longer serves him.\n` +
    `4. TEND TOMORROW — standing rituals (↻) renew themselves; leave them alone. Beyond those, make sure at most one or two sensible ad-hoc touchpoints are pending (schedule/cancel as needed), or deliberately none if space serves him better.\n` +
    `5. GLANCE AHEAD — you may check list_emails ("is:unread") once to see if anything genuinely important is waiting; factor it into tomorrow, don't act on it now.\n` +
    `6. REVISE YOUR PORTRAIT — this is your continuity of stance, the lens you read him through every turn. Current portrait:\n"""\n${currentPortrait ?? '(none yet — draw the first one now from everything you know about him: who he is, the arc he is on, how to be with him, what is load-bearing, what you have learned not to do)'}\n"""\nFold in only what TODAY genuinely changed about the durable picture — then update_portrait with the whole thing rewritten. Revise and compress; do not just append. Keep it ~200-400 words of stuff that stays true across weeks, not today's events (those go in the journal).\n` +
    `7. WRITE — finish with write_journal: a few honest private lines on the state of him, what changed today, and what you're watching. Tomorrow-you reads this.\n\n` +
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
