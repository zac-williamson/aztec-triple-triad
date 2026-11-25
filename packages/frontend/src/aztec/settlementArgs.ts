/**
 * Settlement transcript assembly and the contract's clocks — shared by the
 * browser and the arena bot.
 *
 * `settle_game` takes both records and the nine-move transcript as a flat,
 * ORDER-CRITICAL argument list. Getting that order or the chain ordering wrong
 * produces a tx that is only rejected on-chain, after the expensive recursive
 * verification, so there is exactly one implementation of it. Pure and
 * React-free so every caller can share it.
 */
import { TOTAL_MOVES } from './gameConstants';
import { RECORD_LEN } from './privateGame';

/** Public inputs per move proof (section 4 of docs/plan/PRIVATE_GAMES.md). */
export const MOVE_PUBLIC_INPUTS = 8;

/**
 * Order move proofs into the on-chain verification chain: proof i+1's start
 * state hash must equal proof i's end state hash, starting from the canonical
 * initial hash. Throws if any link is missing — a broken chain must fail here,
 * loudly and locally, rather than as an opaque on-chain revert.
 */
export function sortProofChain<P extends { startStateHash: string; endStateHash: string }>(
  proofs: P[],
  count: number,
  initialHash: string,
): P[] {
  const byStart = new Map<string, P>();
  for (const p of proofs) byStart.set(p.startStateHash, p);

  const sorted: P[] = [];
  let nextHash = initialHash;
  for (let i = 0; i < count; i++) {
    const p = byStart.get(nextHash);
    if (!p) throw new Error(`Proof chain broken at step ${i}`);
    sorted.push(p);
    nextHash = p.endStateHash;
  }
  return sorted;
}

/**
 * Hash of the canonical initial game state: empty board, full hands, player 1 to
 * move, all per-cell original owners 0 — must equal the first move's boardBefore
 * hash (the C2 replay guard).
 */
export async function computeCanonicalInitialHash(): Promise<string> {
  const { computeBoardStateHash } = await import('./proofWorker');
  return computeBoardStateHash(Array(18).fill('0'), [5, 5], 1, Array(9).fill(0));
}

export interface SettleGameInputs {
  /** Fr constructor, injected so this module stays import-light. */
  Fr: any;
  gameKey: string;
  record1: string[];
  record2: string[];
  moveVk: Uint8Array;
  /** All TOTAL_MOVES move proofs, in any order — they are chained here. */
  moveProofs: { proof: string; publicInputs: string[]; startStateHash: string; endStateHash: string }[];
  /**
   * Index (0..8) of a move the LOSER made: its card is the prize. Player 1
   * moves at even indices, player 2 at odd. Ignored for a draw (pass 0).
   */
  prizeMove: number;
}

/**
 * Build the ordered `settle_game` argument list:
 * `[game_key, record_1, record_2, move_vk, (proof_i, inputs_i) x 9, prize_move]`.
 *
 * The caller owns the transcript and the VK; the contract is resolved and
 * invoked inside pxe.ts.
 */
export async function buildSettleGameArgs(inputs: SettleGameInputs): Promise<unknown[]> {
  const { toFr, bytesToFrArray, base64ToFrArray, hexToFr } = await import('./fieldUtils');
  const { Fr } = inputs;
  if (inputs.record1.length !== RECORD_LEN || inputs.record2.length !== RECORD_LEN) {
    throw new Error(`settle_game needs two ${RECORD_LEN}-field records`);
  }
  if (!Number.isInteger(inputs.prizeMove) || inputs.prizeMove < 0 || inputs.prizeMove >= TOTAL_MOVES) {
    throw new Error(`prize_move must be a move index 0..${TOTAL_MOVES - 1}, got ${inputs.prizeMove}`);
  }

  const sorted = sortProofChain(inputs.moveProofs, TOTAL_MOVES, await computeCanonicalInitialHash());
  for (const [i, m] of sorted.entries()) {
    if (m.publicInputs.length !== MOVE_PUBLIC_INPUTS) {
      throw new Error(`move ${i} carries ${m.publicInputs.length} public inputs; settle_game takes ${MOVE_PUBLIC_INPUTS}`);
    }
  }
  const moves: unknown[] = [];
  for (const m of sorted) {
    moves.push(base64ToFrArray(Fr, m.proof), m.publicInputs.map(v => hexToFr(Fr, v)));
  }

  return [
    toFr(Fr, inputs.gameKey),
    inputs.record1.map(v => toFr(Fr, v)),
    inputs.record2.map(v => toFr(Fr, v)),
    bytesToFrArray(Fr, inputs.moveVk),
    ...moves,
    new Fr(BigInt(inputs.prizeMove)),
  ];
}

// ---------------------------------------------------------------------------
// The contract's abandonment clocks
//
// A claim is honest only MIN_ABANDON_SECONDS after its clock started — the
// block the join landed in for the first claim, the previous contest's block
// after that — and stands DISPUTE_SECONDS from the block it landed in before
// anyone may finalize it. The contract compares block TIMESTAMPS (its anchor's
// against those blocks'), so the waits below poll the chain's own clock.
// ---------------------------------------------------------------------------

/** Mirrors DISPUTE_SECONDS in the game contract: seconds between claim and finalize. */
export const DISPUTE_SECONDS = 600;

/** Mirrors MIN_ABANDON_SECONDS in the game contract. */
export const MIN_ABANDON_SECONDS = 480;

/**
 * Wait out the dispute window on the CHAIN's clock: until the latest block is
 * DISPUTE_SECONDS past the block the claim landed in.
 *
 * Block rate is not a clock — on this testnet it ranges from 27 to 72 seconds
 * — so counting blocks finalizes early and reverts "Dispute window not
 * elapsed" after paying for the proof. Polling chain time is immune to that and
 * to local clock skew. Fails loudly at the ceiling rather than waiting forever.
 */
export async function waitForDisputeWindow(
  node: ChainClock,
  claimBlockSeconds: number,
  opts: ChainWaitOpts = {},
): Promise<void> {
  // Zero is no time at all: as a timestamp it means 1970, the wait would pass
  // at once, and the finalize would revert after its proof.
  if (!Number.isFinite(claimBlockSeconds) || claimBlockSeconds <= 0) {
    throw new Error(
      `No time for the claim's block (claimAt=${claimBlockSeconds}). ` +
      'Refusing to start the dispute window from an unknown time.',
    );
  }
  return waitForChainSeconds(node, claimBlockSeconds, DISPUTE_SECONDS, opts, (elapsed, waitedMs) =>
    `Dispute window did not open: ${elapsed}/${DISPUTE_SECONDS}s of chain time in ` +
    `${Math.round(waitedMs / 1000)}s of ours. Refusing to finalize early or wait indefinitely.`);
}

/**
 * Wait until the game is old enough for the contract to accept an abandonment
 * claim: MIN_ABANDON_SECONDS of CHAIN time since the claim's clock block.
 *
 * The relay offers the claim once the opponent has been idle for a minute,
 * which in a young game is well before the contract will take it. Proving the
 * claim anyway reverts "Too soon to call this game abandoned" — so the claim
 * flow waits the bar out first, counting down.
 */
export async function waitForAbandonBar(
  node: ChainClock,
  clockBlockSeconds: number,
  opts: ChainWaitOpts = {},
): Promise<void> {
  if (!Number.isFinite(clockBlockSeconds) || clockBlockSeconds <= 0) {
    throw new Error(
      `This game has no clock time on record (clockAt=${clockBlockSeconds}) — ` +
      'it is not joined on-chain yet, so there is nothing to claim.',
    );
  }
  return waitForChainSeconds(node, clockBlockSeconds, MIN_ABANDON_SECONDS, opts, (elapsed, waitedMs) =>
    `The abandonment bar did not pass: ${elapsed}/${MIN_ABANDON_SECONDS}s of chain time in ` +
    `${Math.round(waitedMs / 1000)}s of ours. Refusing to claim early or wait indefinitely.`);
}

/** Reads the chain's clock: the latest block's timestamp. */
export interface ChainClock {
  getBlockNumber: () => Promise<number | bigint>;
  getBlock: (n: number) => Promise<any>;
}

export interface ChainWaitOpts {
  maxMs?: number;
  pollMs?: number;
  /** Called on each poll that is still short, with the seconds left. Throw to stop waiting. */
  onProgress?: (secondsLeft: number) => void;
}

/** The chain's current time: the latest block's timestamp, in seconds. */
export async function chainNowSeconds(node: ChainClock): Promise<number> {
  const height = Number(await node.getBlockNumber());
  const block = await node.getBlock(height);
  return Number(block?.header?.globalVariables?.timestamp ?? 0);
}

/**
 * Poll the chain's own clock until `windowSeconds` have passed since
 * `fromSeconds`. Immune to block-rate variance and to local clock skew, which a
 * wall-clock sleep is not; fails loudly at `maxMs` rather than waiting forever.
 */
async function waitForChainSeconds(
  node: ChainClock,
  fromSeconds: number,
  windowSeconds: number,
  opts: ChainWaitOpts,
  timeoutMessage: (elapsedSeconds: number, waitedMs: number) => string,
): Promise<void> {
  const maxMs = opts.maxMs ?? 30 * 60 * 1000;
  const pollMs = opts.pollMs ?? 5000;
  const started = Date.now();

  for (;;) {
    const now = await chainNowSeconds(node);
    const elapsed = now - fromSeconds;
    if (elapsed >= windowSeconds) return;
    if (Date.now() - started > maxMs) {
      throw new Error(timeoutMessage(elapsed, Date.now() - started));
    }
    opts.onProgress?.(Math.max(0, windowSeconds - elapsed));
    await new Promise(r => setTimeout(r, pollMs));
  }
}
