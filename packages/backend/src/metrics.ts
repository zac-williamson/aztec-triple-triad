/**
 * Process-local counters for the /metrics endpoint.
 *
 * Deliberately dependency-free and in-memory: this is operational visibility for
 * "is the arena bot working, and if not which way is it broken", not analytics.
 * Counters reset on restart, which is fine — the questions they answer
 * ("are matches forming?", "is the bot losing every game?", "are settlements
 * failing?") are about the current process's health.
 *
 * Anything that needs history should scrape this endpoint on an interval.
 */

export interface MetricsSnapshot {
  startedAt: number;
  uptimeMs: number;
  /** Games created, by how the opponent was found. */
  gamesCreated: number;
  gamesCompleted: number;
  /** Matches formed from the queue (both human, or human+bot). */
  matchesFormed: number;
  /** Matches where one side was the arena bot. */
  botMatchesFormed: number;
  /** Bot game outcomes, from the bot's point of view. */
  botWins: number;
  botLosses: number;
  botDraws: number;
  /** Net cards the bot has gained (+) or lost (-) through settlement. */
  botCardNetFlow: number;
  /** Failures, split so a spike points at the right subsystem. */
  botJoinFailures: number;
  botMoveFailures: number;
  botSettleFailures: number;
  /** Longest observed wait between queueing and being matched, ms. */
  maxMatchWaitMs: number;
  /** Rolling mean of match wait, ms. */
  meanMatchWaitMs: number;
}

const counters = {
  gamesCreated: 0,
  gamesCompleted: 0,
  matchesFormed: 0,
  botMatchesFormed: 0,
  botWins: 0,
  botLosses: 0,
  botDraws: 0,
  botCardNetFlow: 0,
  botJoinFailures: 0,
  botMoveFailures: 0,
  botSettleFailures: 0,
};

type CounterName = keyof typeof counters;

let startedAt = Date.now();
let maxMatchWaitMs = 0;
let matchWaitTotal = 0;
let matchWaitCount = 0;

export function increment(name: CounterName, by = 1): void {
  counters[name] += by;
}

/** Record how long a player waited in the queue before being matched. */
export function recordMatchWait(waitMs: number): void {
  if (!Number.isFinite(waitMs) || waitMs < 0) return;
  if (waitMs > maxMatchWaitMs) maxMatchWaitMs = waitMs;
  matchWaitTotal += waitMs;
  matchWaitCount += 1;
}

export function snapshot(): MetricsSnapshot {
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    ...counters,
    maxMatchWaitMs,
    meanMatchWaitMs: matchWaitCount === 0 ? 0 : Math.round(matchWaitTotal / matchWaitCount),
  };
}

/** Test-only: restore a pristine process-local state. */
export function reset(): void {
  for (const key of Object.keys(counters) as CounterName[]) counters[key] = 0;
  startedAt = Date.now();
  maxMatchWaitMs = 0;
  matchWaitTotal = 0;
  matchWaitCount = 0;
}
