import { config, isQuietHours } from '../config.js';
import { touchpoints } from '../db/repositories.js';
import { runAgent } from '../agent/orchestrator.js';
import { sendToOwner } from '../telegram/bot.js';

let running = false;

/**
 * One scheduler tick: fire any due touchpoints — unless we're in quiet hours,
 * in which case they stay pending and naturally fire once the window passes.
 * The agent schedules its NEXT touchpoint from inside each runAgent call.
 */
async function tick(): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    if (isQuietHours()) return; // hold proactive reach-outs overnight

    const due = await touchpoints.due();
    for (const tp of due) {
      try {
        const result = await runAgent({ kind: 'touchpoint', touchpoint: tp });
        await touchpoints.setStatus(tp.id, 'fired');
        if (result.message) {
          await sendToOwner(result.message);
          console.log(`[scheduler] fired touchpoint ${tp.id}, messaged owner.`);
        } else {
          console.log(`[scheduler] fired touchpoint ${tp.id}, agent stayed silent.`);
        }
      } catch (err) {
        console.error(`[scheduler] touchpoint ${tp.id} failed:`, err);
        // leave it pending so it retries next tick
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
    `[scheduler] due-check every ${config.dueCheckIntervalMs}ms; quiet hours ${config.quietStart}:00–${config.quietEnd}:00 ${config.timezone}.`
  );
  // run once on boot, then on the interval
  void tick();
  setInterval(() => void tick(), config.dueCheckIntervalMs);
}
