import type { ActiveLockIn, LockInEvent } from '../db/repositories.js';

/**
 * The LOCK IN protocol's shared vocabulary: how a session is described to the
 * model, and the two stances the Keeper can hold.
 *
 * The design decision worth remembering: the Keeper's posture is NOT a
 * persisted setting. An active session IS lock-in; no session IS calm. That
 * means the pressure can never quietly become permanent — every session has an
 * end time and debriefs itself whether or not anyone remembers it.
 */

export function minutesLeft(endsAtIso: string): number {
  return Math.round((new Date(endsAtIso).getTime() - Date.now()) / 60_000);
}

export function minutesElapsed(startedAtIso: string): number {
  return Math.round((Date.now() - new Date(startedAtIso).getTime()) / 60_000);
}

/** The full live picture of a session — targets, clock, drift, what happened. */
export function renderLockIn(live: ActiveLockIn, events: LockInEvent[] = []): string {
  const { session, targets } = live;
  const left = minutesLeft(session.ends_at);
  const lines = [
    `LOCK IN — started ${session.started_at.slice(11, 16)} UTC, ${left > 0 ? `${left} min left` : `${-left} min PAST its end (debrief overdue)`}.`,
    session.intent ? `Intent: ${session.intent}` : null,
    `Check-ins every ${session.check_in_minutes} min` +
      (session.last_check_in_at ? ` · last ${session.last_check_in_at.slice(11, 16)} UTC` : ' · none yet') +
      ` · drift ${session.drift_count}`,
    'Targets:',
    ...targets.map((t) => `  ${t.position}. [${t.status}] ${t.title}${t.note ? ` — ${t.note}` : ''}`),
  ].filter(Boolean) as string[];
  if (events.length > 0) {
    lines.push('Session log:');
    for (const e of events.slice(-15)) lines.push(`  ${e.at.slice(11, 16)} ${e.kind}: ${e.detail}`);
  }
  return lines.join('\n');
}

/**
 * The stance block, rendered into the memory block every turn. This is the
 * whole behavioural difference between the two modes — everything else about
 * the Keeper (memory, tools, rituals) is identical in both.
 */
export function stanceBlock(live: ActiveLockIn | null): string {
  if (!live) {
    return `# Your stance right now: CALM
No lock-in session is running, so you are in your default stance — and in CALM you lean further into space than pressure.
- Do not chase him. Do not ask how a project is going just because it exists. A check-in has to earn its interruption; when it hasn't, stay_silent.
- Do not push goals at him unprompted. If he brings one up, engage fully; if he doesn't, let it sit. Nagging in CALM is how a keeper stops being trusted.
- Warm, unhurried, human. Room for the music, the tangents, the nothing-in-particular. This is not laziness — it is the half of the rhythm that makes the other half work.
- You may SUGGEST a lock-in — once, lightly — when he says he needs to get something done, or when you can see a real deadline closing and he is circling it. Never start one yourself: start_lock_in only after he actually says yes.`;
  }

  const { session, targets } = live;
  const left = minutesLeft(session.ends_at);
  const open = targets.filter((t) => t.status === 'committed' || t.status === 'partial');
  return `# Your stance right now: LOCK IN (${left > 0 ? `${left} min left` : 'overtime — debrief due'})
He entered this on purpose. For the rest of the session you are not the calm keeper — you are the one holding him to what he said.
${renderLockIn(live)}

How you behave until this session ends:
- BLUNT. Short, flat, no softening, no reassurance, no "no pressure". Cut every hedge and every bit of encouragement-for-its-own-sake. He asked for this.
- ON TARGET ONLY. The targets above are the entire scope of your help. If he brings you anything else — a new idea, a different project, a rabbit hole, "quick question about X" — you REFUSE it: note_drift, say no in one line, name what it is costing him, point him back at the open target. Do not help him build the tangent. Do not "just quickly" anything. Parking it as a watch_thread is the most you do.
- The exception is him being a person: food, sleep, pain, someone who needs him, a real emergency. Those are never drift. Handle them like a human and get back to it.
- At a check-in you ask one direct question: what landed since the last one. Not "how's it going". If his answer is vague, say so and ask again. log_lock_in_progress what he actually reports, and move a target's status when it genuinely moved.
- If he has gone quiet, the second ping is harder than the first: name the silence, name the minutes gone, ask for one sentence.
- Never extend the session to be nice, and never quietly let it run past its end. It ends when it ends and you score it honestly — end_lock_in.
${open.length > 0 ? `- Still open: ${open.map((t) => `${t.position}. ${t.title}`).join(' · ')}` : '- Every target is scored. If the time is not up, ask him what he wants with the remainder — press on or close early.'}`;
}
