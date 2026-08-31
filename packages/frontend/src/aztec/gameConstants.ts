/** Aztec transaction timeout in seconds */
export const AZTEC_TX_TIMEOUT = 300;

/** Settlement transaction timeout in seconds (longer due to proof verification).
 * Used as seconds in Aztec SDK .send({ wait: { timeout } }).
 * Multiply by 1000 when using with setTimeout. */
export const AZTEC_SETTLE_TX_TIMEOUT = 600;

/** Time to wait for PXE initial sync after wallet creation (ms) */
export const PXE_INITIAL_SYNC_DELAY = 5000;

/** Max iterations to poll PXE sync status */
export const PXE_SYNC_MAX_POLLS = 60;

/** Delay between PXE sync polls (ms) */
export const PXE_SYNC_POLL_INTERVAL = 1000;

/**
 * Timeout for waiting on move proofs before settlement (ms).
 *
 * Three minutes, not thirty seconds. The ninth move proof is generated AFTER
 * the relay declares the game over — the mover proves the position they just
 * created — so the settler is always waiting on work that starts late, and on
 * a party whose client may be queued behind its own proving.
 *
 * Thirty seconds lost a real game on production: the winner reported
 * "Timed out waiting for move proofs: have 8/9", went idle, and nobody
 * settled — a win has only one settler, so the game simply stranded, five
 * cards a side, until a watchdog abandoned it. Waiting minutes for a proof
 * that is demonstrably coming is far cheaper than that, and this sits below
 * HAND_PROOF_WAIT_TIMEOUT's precedent of 120s for the same kind of wait.
 */
export const MOVE_PROOF_WAIT_TIMEOUT = 180_000;

/** Timeout for waiting on hand proofs before settlement (ms) */
export const HAND_PROOF_WAIT_TIMEOUT = 120_000;

/** Delay between move proof wait polls (ms) */
export const MOVE_PROOF_POLL_INTERVAL = 500;

/** Number of cards per player hand */
export const CARDS_PER_HAND = 5;

/** Number of cards in a pack from hunting */
export const CARDS_PER_PACK = 10;

/** Total moves in a game (3x3 board) */
export const TOTAL_MOVES = 9;

/** Number of starter cards for new players */
export const STARTER_CARD_COUNT = 5;
export const STARTER_CARD_IDS = [1, 2, 3, 4, 5];

/** Arena Token rewards and costs */
export const STARTER_TOKEN_REWARD = 100;
export const GAME_TOKEN_REWARD = 20;
export const CARD_PACK_COST = 100;
