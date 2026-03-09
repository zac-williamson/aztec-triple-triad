/** Aztec transaction timeout in seconds */
export const AZTEC_TX_TIMEOUT = 300;

/** Settlement transaction timeout (longer due to proof verification) */
export const AZTEC_SETTLE_TX_TIMEOUT = 600;

/** Time to wait for PXE initial sync after wallet creation (ms) */
export const PXE_INITIAL_SYNC_DELAY = 5000;

/** Max iterations to poll PXE sync status */
export const PXE_SYNC_MAX_POLLS = 60;

/** Delay between PXE sync polls (ms) */
export const PXE_SYNC_POLL_INTERVAL = 1000;

/** Timeout for waiting on move proofs before settlement (ms) */
export const MOVE_PROOF_WAIT_TIMEOUT = 30_000;

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
