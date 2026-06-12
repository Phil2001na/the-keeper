import { config, isQuietHours, localHour } from '../config.js';
import { touchpoints, type Touchpoint } from '../db/repositories.js';
import { runAgent } from '../agent/orchestrator.js';
import { nextOccurrence } from '../agent/recurrence.js';
import { runNightlyReflection, reflectionPending } from '../agent/reflect.js';
import { sendToOwner, flushMediaToOwner } from '../telegram/bot.js';

/**
 * A fired ritual renews itself — reliability lives here, not in the model
 * remembering to reschedule. Cancelling the pending row kills the chain.
 */
async function renewRitual(tp: Touchpoint): Promise<void> {
  if (!tp.recurrence) return;
  const next = nextOccurrence(tp.recurrence);
  if (!next) {
    console.error(`[scheduler] ritual ${tp.id} has unparseable recurrence "${tp.recurrence}" — not renewed.`);
    return;
  }
  await touchpoints.create({
    fire_at: next.toISOString(),
    domain_id: tp.domain_id,
    reason: tp.reason,
    recurrence: tp.recurrence,
  });
  console.log(`[scheduler] ritual renewed (${tp.recurrence}) → next ${next.toISOString()}.`);
}

let running = false;

/**
 * One scheduler tick: fire any due touchpoints — unless we're in quiet hours,
 * in which case they stay pending and naturally fire once the window passes.
 * The agent schedules its NEXT touchpoint from inside each runAgent call.
 * Once per evening (REFLECTION_HOUR) the tick also runs the nightly reflection.
 */
async function tick(): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    if (!isQuietHours()) {
      const due = await touchpoints.due();
      for (const tp of due) {
        try {
          const result = await runAgent({ kind: 'touchpoint', touchpoint: tp });
          await touchpoints.markFired(tp.id, result.message ? 'sent' : 'silent');
          await renewRitual(tp).catch((err) =>
            console.error(`[scheduler] failed to renew ritual ${tp.id}:`, err)
          );
          if (result.message) {
            await sendToOwner(result.message);
            console.log(`[scheduler] fired touchpoint ${tp.id}, messaged owner.`);
          } else {
            console.log(`[scheduler] fired touchpoint ${tp.id}, agent stayed silent.`);
          }
          await flushMediaToOwner();
        } catch (err) {
          console.error(`[scheduler] touchpoint ${tp.id} failed:`, err);
          // leave it pending so it retries next tick
        }
      }
    }

    // Nightly reflection — private, never messages him, once per local day.
    // Window: REFLECTION_HOUR until midnight, so a brief restart can't skip a
    // night. (Quiet hours don't apply: reflection is thinking, not talking.)
    if (localHour() >= config.reflectionHour && (await reflectionPending())) {
      try {
        console.log('[scheduler] running nightly reflection...');
        await runNightlyReflection();
      } catch (err) {
        console.error('[scheduler] nightly reflection failed:', err);
      }
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  console.log(
    `[scheduler] due-check every ${config.dueCheckIntervalMs}ms; quiet hours ${config.quietStart}:00–${config.quietEnd}:00 ${config.timezone}; reflection at ${config.reflectionHour}:00.`
  );
  // run once on boot, then on the interval
  void tick();
  setInterval(() => void tick(), config.dueCheckIntervalMs);
}
