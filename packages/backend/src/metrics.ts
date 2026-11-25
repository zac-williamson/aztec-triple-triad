/**
 * Process-local counters for the /metrics endpoint.
 *
 * Deliberately dependency-free and in-memory: this is operational visibility for
 * "is the arena working, and if not which way is it broken", not analytics.
 * Counters reset on restart, which is fine — the questions they answer ("are
 * matches forming?", "are games getting all the way through?") are about the
 * current process's health.
 *
 * Nothing here says who won. The relay cannot know: it forwards sealed moves
 * and never sees a card (docs/plan/PRIVATE_GAMES.md §6). The bot reports its
 * own results, on its own /health.
 *
 * Anything that needs history should scrape this endpoint on an interval.
 */

export interface MetricsSnapshot {
  startedAt: number;
  uptimeMs: number;
  /** Rooms opened. Matchmaking is the only way a room opens. */
  gamesCreated: number;
  /** Rooms whose ninth MOVE was relayed: every move went through. */
  gamesCompleted: number;
  /** Matches formed from the queue (both human, or human+bot). */
  matchesFormed: number;
  /** Matches where one side was the arena bot. */
  botMatchesFormed: number;
  /**
   * Net cards the bot has gained (+) or lost (-) through settlement.
   *
   * NOT MEASURABLE HERE: settlement is on-chain and the relay sees no card at
   * all, so this always reads 0. Called out explicitly because this is the
   * counter that answers "is the bot being farmed?", and a silent zero would
   * read as "healthy" rather than "not measured". The bot's own /health is
   * where card flow can be seen.
   */
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
