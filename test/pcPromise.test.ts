// The tripwire for "said Claude was on it, never started a session".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisesPcDispatch } from '../src/agent/pcPromise.js';

// Real replies from 2026-10-13 that were sent with no session behind them.
const BROKEN = [
  'i’ll check whether the PC is unlocked and, if it is, navigate to the relevant Antares page and capture what’s visible. I won’t click install, cancel anything, or change settings.',
  'i’ll have Claude force-close Auto-Tune Central, then attempt a headless install of only Auto-Tune Advanced and Auto-Tune Pro 11.',
  'i’ll have Claude check whether Auto-Tune Central can be closed and reopened without losing the partial download.',
  "on its way — Claude is reading the file and will return the token here.",
  "I've sent Claude to inspect the PC and show the current status.",
];

// Replies that talk about Claude or the PC without claiming anything is running.
const FINE = [
  'yes — for the Antares task, I was talking to one Claude session: dede4643. It finished its inspection earlier.',
  'it’s not progressing — it’s still stuck at 48%. The session finished earlier and didn’t close or restart anything.',
  'I can start Claude Code sessions on your PC for actual coding work, while risky actions require your approval.',
  'Nothing has been started yet. Want me to have Claude look at it?',
  'call Clean Pro back today about setting up their Google Business Profile.',
  'i’ll check your inbox and get back to you.',
];

test('flags replies that promise a PC session', () => {
  for (const t of BROKEN) assert.equal(promisesPcDispatch(t), true, t);
});

test('leaves ordinary replies alone', () => {
  for (const t of FINE) assert.equal(promisesPcDispatch(t), false, t);
});
