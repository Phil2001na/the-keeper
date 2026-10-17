// Which sessions the PC can take on right now. Two lanes:
//   prime   Meeseeks Prime sessions, running or idle between asks. Capped at
//           maxPrimes (never more than PRIME_HARD_MAX), the backstop behind the
//           relay's own limit.
//   work    everything else (solo Meeseeks, Prime's workers), running only.
//           Capped at maxParallel, so Primes never use up the slots their own
//           crew and his one-off Meeseeks need.
// Pure, so test/lanes.test.ts can check it without starting the agent.

/** Primes allowed at once, whatever projects.json says. Matches the relay (PC_MAX_PRIMES). */
export const PRIME_HARD_MAX = 3;

export function primeLimit(configured) {
  const n = Number(configured);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), PRIME_HARD_MAX) : PRIME_HARD_MAX;
}

const isPrime = (j) => j?.role === 'prime';

/**
 * Null if `job` may run now, else why not (said to him as the session's ending).
 * `running` / `idle` are the agent's Maps; `followup` = it resumes a session already counted.
 */
export function refusal(job, { running, idle, maxParallel, maxPrimes }, followup = false) {
  if (isPrime(job)) {
    if (followup) return null; // an idle Prime already holds its slot
    const primes = [...running.values(), ...idle.values()].filter(isPrime).length;
    return primes >= maxPrimes ? `${primes} Meeseeks Primes are already up on the PC (limit ${maxPrimes}), so another one was not started.` : null;
  }
  const work = [...running.values()].filter((j) => !isPrime(j)).length;
  return work >= maxParallel ? `PC is already running ${work} sessions` : null;
}
