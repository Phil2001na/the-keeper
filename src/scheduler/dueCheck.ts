import { config, isQuietHours, localHour } from '../config.js';
import { touchpoints, lockIn, interactions, type Touchpoint } from '../db/repositories.js';
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

/**
 * The lock-in protocol's clock. The model is never asked to remember a
 * timer — the scheduler owns the rhythm, exactly like touchpoint firing:
 *
 *  - past ends_at            → debrief (once), then the session is closed in
 *                              code whether or not the model called end_lock_in,
 *                              so a failed turn can never leave him locked in;
 *  - check-in interval due   → one direct "what landed" ping;
 *  - half an interval after  → if he still hasn't said anything, ONE harder
 *    an unanswered ping        ping. Never a third — that's nagging, not pressure.
 *
 * Quiet hours deliberately do not apply: he opted into a bounded session with
 * a known end time, and a check-in that silently skips is worse than useless.
 */
async function lockInTick(): Promise<void> {
  const live = await lockIn.active();
  if (!live) return;
  const { session } = live;
  const now = Date.now();

  const say = async (phase: 'check_in' | 'escalation' | 'debrief'): Promise<void> => {
    const result = await runAgent({ kind: 'lockin', phase, live });
    if (result.message) {
      await sendToOwner(result.message);
      await flushMediaToOwner();
    }
    console.log(`[lock-in] ${phase} fired for session ${session.id.slice(0, 8)}.`);
  };

  if (now >= new Date(session.ends_at).getTime()) {
    try {
      await say('debrief');
    } finally {
      // Belt and braces: end_lock_in normally does this from inside the turn,
      // but a session must never survive its own end time.
      const stillOpen = await lockIn.active();
      if (stillOpen && stillOpen.session.id === session.id) {
        await lockIn.end(session.id, { debrief: stillOpen.session.debrief ?? 'Auto-closed at end of session.' });
        console.log(`[lock-in] session ${session.id.slice(0, 8)} auto-closed.`);
      }
    }
    return;
  }

  const anchor = new Date(session.last_check_in_at ?? session.started_at).getTime();
  const interval = session.check_in_minutes * 60_000;

  if (now - anchor >= interval) {
    await lockIn.markCheckIn(session.id, false);
    await lockIn.logEvent(session.id, 'check_in', 'Timed check-in fired.');
    await say('check_in');
    return;
  }

  // One harder ping, half an interval into an unanswered check-in.
  if (!session.escalated && session.last_check_in_at && now - anchor >= interval / 2) {
    const answered = await interactions.since(session.last_check_in_at, 'user');
    if (answered === 0) {
      await lockIn.markCheckIn(session.id, true);
      await lockIn.logEvent(session.id, 'escalation', 'No reply to the check-in — escalated.');
      await say('escalation');
    }
  }
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

    // The lock-in clock runs before the reflection check and outside the quiet-hours
    // gate above: a session he opted into owns its own time.
    try {
      await lockInTick();
    } catch (err) {
      console.error('[scheduler] lock-in tick failed:', err);
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
