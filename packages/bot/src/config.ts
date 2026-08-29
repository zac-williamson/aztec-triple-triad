import type { BotDifficulty } from '@axolotl-arena/game-logic';

export interface ArenaBotConfig {
  /** WebSocket relay URL, e.g. ws://localhost:5174 */
  wsUrl: string;
  /** HTTP base of the same backend, for /queue polling, e.g. http://localhost:5174 */
  httpUrl: string;
  /** Shared secret matching the backend's ARENA_BOT_TOKEN. */
  token: string;
  /**
   * How long a human must have been waiting before the bot offers itself.
   *
   * NOTE: the product goal behind this number ("players should not wait") is
   * only partly served by it — on-chain create/join dominate the wall clock at
   * ~2.5 min, so 20s of queue is not where the wait actually is. Kept
   * configurable and defaulted to the requested 20s, but see
   * docs/plan/BACKEND_OPPONENT.md §4 before tuning it down further.
   */
  joinThresholdMs: number;
  /** How often to poll /queue. */
  pollIntervalMs: number;
  /**
   * Give up and leave the queue if no match forms in this long — otherwise a
   * human cancelling right as the bot queues would leave the bot parked in the
   * queue, where it would match the NEXT human instantly and defeat the point.
   */
  queueTimeoutMs: number;
  /** Which cards the bot commits to a game. */
  handCardIds: number[];
  /** Bot strength. 'greedy' is a reasonable default: beatable but not random. */
  difficulty: BotDifficulty;
  /** Pause before playing a move, so the bot does not feel inhumanly instant. */
  moveDelayMs: number;
  /**
   * Concurrent games. Phase 1 ships 1 as requested, but the code must not
   * ASSUME 1: with a single identity every extra player is head-of-line blocked
   * behind a ~10 min game, which is worse than the wait it set out to fix. Each
   * slot needs its own account/cards, so >1 lands with the identity pool.
   */
  maxConcurrentGames: number;
  /** Timeout for an on-chain tx (create_game/join_game). Proving dominates. */
  chainTxTimeoutMs: number;
  /** How long to wait after GAME_OVER for the 11-proof transcript to complete. */
  settleWaitMs: number;
}

const int = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ArenaBotConfig {
  const difficulty = (env.ARENA_BOT_DIFFICULTY ?? 'greedy') as BotDifficulty;
  if (!['random', 'greedy', 'lookahead'].includes(difficulty)) {
    throw new Error(`ARENA_BOT_DIFFICULTY must be random|greedy|lookahead, got '${difficulty}'`);
  }
  const token = env.ARENA_BOT_TOKEN ?? '';
  if (!token) throw new Error('ARENA_BOT_TOKEN is required (must match the backend)');

  const handCardIds = (env.ARENA_BOT_CARDS ?? '1,2,3,4,5')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 256);
  if (handCardIds.length !== 5) {
    throw new Error(`ARENA_BOT_CARDS must list exactly 5 card ids in 1..256, got ${handCardIds.length}`);
  }

  return {
    wsUrl: env.ARENA_BOT_WS_URL ?? 'ws://localhost:5174',
    httpUrl: env.ARENA_BOT_HTTP_URL ?? 'http://localhost:5174',
    token,
    joinThresholdMs: int(env.ARENA_BOT_JOIN_THRESHOLD_MS, 20_000),
    pollIntervalMs: int(env.ARENA_BOT_POLL_INTERVAL_MS, 2_000),
    queueTimeoutMs: int(env.ARENA_BOT_QUEUE_TIMEOUT_MS, 60_000),
    handCardIds,
    difficulty,
    moveDelayMs: int(env.ARENA_BOT_MOVE_DELAY_MS, 1_200),
    maxConcurrentGames: int(env.ARENA_BOT_MAX_CONCURRENT_GAMES, 1),
    chainTxTimeoutMs: int(env.ARENA_BOT_CHAIN_TX_TIMEOUT_MS, 600_000),
    settleWaitMs: int(env.ARENA_BOT_SETTLE_WAIT_MS, 300_000),
  };
}
