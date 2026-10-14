/**
 * Catches the one failure a relay cannot: the model telling him "Claude is on
 * it" without ever calling start_claude_session. Nothing runs, so nothing ever
 * reports back, and from his side the Keeper simply went quiet.
 *
 * This is a tripwire, not a judge. It only decides whether the reply is worth
 * one extra round in which the model either makes the call or takes the claim
 * back, so a false positive costs a few tokens and a false negative is the bug
 * it was written for. Kept free of imports so it can be tested on its own.
 */

/** What the work would be done by or on. */
const TARGET = /\b(claude|pc|computer|laptop|desktop|session|screenshot)\b/i;

/** First-person commitments to go and do it, or claims that it is already under way. */
const COMMITMENT = [
  /\bi\s*['’]?\s*(ll|will)\s+(now\s+|just\s+|go\s+and\s+)?(have|get|ask|tell|send|dispatch|start|run|check|look|inspect|navigate|open|capture|screenshot|grab|kick|fire|hand|pass)\b/i,
  /\bi\s*['’]?\s*(ve|have)\s+(now\s+|just\s+)?(sent|started|dispatched|asked|told|queued|kicked|fired|handed|passed)\b/i,
  /\bi\s*['’]?\s*(m|am)\s+(now\s+)?(sending|starting|dispatching|asking|having|getting|checking|handing)\b/i,
  /\b(it['’]?s|it is|that['’]?s|claude is)\s+on\s+(its|the)\s+way\b/i,
  /\bon its way\b/i,
  /\bclaude\s+(is|will)\s+(now\s+)?(read|check|inspect|look|navigat|open|handl|do|tak|captur|work|run)\w*/i,
];

export function promisesPcDispatch(text: string): boolean {
  if (!TARGET.test(text)) return false;
  return COMMITMENT.some((re) => re.test(text));
}

export const PC_PROMISE_NUDGE =
  '[system] Your reply says a Claude session on his PC is being started or is under way, but you did not call ' +
  'start_claude_session in this turn, so nothing is running and nothing will ever report back to him. Fix that now, one of two ways. ' +
  'If he asked for this to happen now and you have what you need: call start_claude_session, then reply. ' +
  'If you are deliberately not starting one (you need his answer first, it is planned for later, the PC is offline): ' +
  'rewrite your reply so it says plainly that nothing has been started yet and what you are waiting for. ' +
  'Do not start a session he did not ask for. Reply to him in your own voice, as if this note were not here.';
