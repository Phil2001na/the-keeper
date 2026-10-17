// The PC agent's own backstop (pc-agent/lanes.mjs): Primes get their own lane,
// capped at three, so they never crowd out one-job Meeseeks or their own crew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain .mjs from the PC agent, no types
import { refusal, primeLimit, PRIME_HARD_MAX } from '../pc-agent/lanes.mjs';

const prime = { role: 'prime' };
const solo = { role: 'solo' };
const worker = { role: 'worker' };
const lanes = (running: object[], idle: object[] = [], maxParallel = 4) => ({
  running: new Map(running.map((j, i) => [`r${i}`, j])),
  idle: new Map(idle.map((j, i) => [`i${i}`, j])),
  maxParallel,
  maxPrimes: 3,
});

test('the PC never takes a fourth Prime, counting idle ones', () => {
  assert.equal(refusal(prime, lanes([prime, prime])), null);
  assert.match(refusal(prime, lanes([prime, prime], [prime])), /3 Meeseeks Primes are already up on the PC \(limit 3\)/);
  assert.notEqual(refusal(prime, lanes([prime], [prime, prime])), null);
  // A follow-up resumes a Prime that already holds its slot.
  assert.equal(refusal(prime, lanes([prime, prime], [prime]), true), null);
});

test('working Primes do not use up the slots Meeseeks and workers need', () => {
  assert.equal(refusal(solo, lanes([prime, prime, prime, worker, worker, worker])), null);
  assert.equal(refusal(worker, lanes([prime, prime, prime, solo, solo, solo])), null);
  assert.match(refusal(solo, lanes([prime, solo, worker, solo, worker])), /already running 4 sessions/);
  // Primes still start when the work lane is full.
  assert.equal(refusal(prime, lanes([solo, solo, worker, worker])), null);
});

test('projects.json can lower the Prime cap but never raise it past three', () => {
  assert.equal(PRIME_HARD_MAX, 3);
  assert.equal(primeLimit(undefined), 3);
  assert.equal(primeLimit(1), 1);
  assert.equal(primeLimit(10), 3);
  assert.equal(primeLimit(0), 3);
  assert.equal(primeLimit('x'), 3);
});
