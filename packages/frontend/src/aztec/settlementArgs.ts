/**
 * Settlement transcript assembly — shared by the browser (useGameSettlement) and
 * the arena bot.
 *
 * `process_game` takes the entire 11-proof transcript as a flat, ORDER-CRITICAL
 * argument list. Getting that order or the chain ordering wrong produces a tx
 * that is only rejected on-chain, after the expensive recursive verification, so
 * there must be exactly one implementation of it. These functions are pure and
 * React-free precisely so both callers can share them.
 */
import { CARDS_PER_HAND, TOTAL_MOVES } from './gameConstants';

/** Pad a card-ID list to a full hand of Fr field elements. */
export function padToHand<F>(Fr: new (v: bigint) => F, ids: number[]): F[] {
  const padded = [...ids];
  while (padded.length < CARDS_PER_HAND) padded.push(0);
  return padded.slice(0, CARDS_PER_HAND).map(id => new Fr(BigInt(id)));
}

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
  return computeBoardStateHash(Array(18).fill('0'), [CARDS_PER_HAND, CARDS_PER_HAND], 1, Array(9).fill(0));
}

export interface ProcessGameInputs {
  /** Fr constructor and AztecAddress, injected so this module stays import-light. */
  Fr: any;
  AztecAddress: any;
  onChainGameId: string;
  handVk: Uint8Array;
  moveVk: Uint8Array;
  /** Both hand proofs, already assigned to their player slots. */
  handProof1: { proof: string; publicInputs: string[] };
  handProof2: { proof: string; publicInputs: string[] };
  /** All TOTAL_MOVES move proofs, in any order — they are chained here. */
  moveProofs: { proof: string; publicInputs: string[]; startStateHash: string; endStateHash: string }[];
  opponentAddress: string;
  selectedCardId: number;
  myCardIds: number[];
  opponentCardIds: number[];
  myRandomness: string[];
  opponentRandomness: string[];
  /**
   * Blinding factors, one per player. The contract recomputes
   * poseidon2([card_ids, blinding]) and asserts it against the commitment
   * stored at create/join — without them it would mint whatever ids it was
   * handed. Yours comes from `compute_blinding_factor(game_id)`; the
   * opponent's is exchanged over the relay at game over, when hands stop being
   * secret.
   */
  myBlinding: string;
  opponentBlinding: string;
}

/**
 * Build the ordered `process_game` argument list.
 *
 * The caller owns the proof transcript and VK fields; the contract is resolved
 * and invoked inside pxe.ts.
 */
export async function buildProcessGameArgs(inputs: ProcessGameInputs): Promise<unknown[]> {
  const { toFr, bytesToFrArray, base64ToFrArray, hexToFr } = await import('./fieldUtils');
  const { Fr, AztecAddress } = inputs;

  const toFrArr = (b64: string) => base64ToFrArray(Fr, b64);
  const toFrHex = (hex: string) => hexToFr(Fr, hex);

  const sorted = sortProofChain(inputs.moveProofs, TOTAL_MOVES, await computeCanonicalInitialHash());
  const mp = sorted.map(m => toFrArr(m.proof));
  const mi = sorted.map(m => m.publicInputs.map(toFrHex));

  return [
    toFr(Fr, inputs.onChainGameId),
    bytesToFrArray(Fr, inputs.handVk),
    bytesToFrArray(Fr, inputs.moveVk),
    toFrArr(inputs.handProof1.proof), inputs.handProof1.publicInputs.map(toFrHex),
    toFrArr(inputs.handProof2.proof), inputs.handProof2.publicInputs.map(toFrHex),
    mp[0], mi[0], mp[1], mi[1], mp[2], mi[2],
    mp[3], mi[3], mp[4], mi[4], mp[5], mi[5],
    mp[6], mi[6], mp[7], mi[7], mp[8], mi[8],
    AztecAddress.fromStringUnsafe(inputs.opponentAddress),
    new Fr(BigInt(inputs.selectedCardId)),
    padToHand(Fr, inputs.myCardIds),
    padToHand(Fr, inputs.opponentCardIds),
    inputs.myRandomness.map(v => toFr(Fr, v)),
    inputs.opponentRandomness.map(v => toFr(Fr, v)),
    toFr(Fr, inputs.myBlinding),
    toFr(Fr, inputs.opponentBlinding),
  ];
}

// ---------------------------------------------------------------------------
// Abandoned-game recovery
//
// The escape hatch when the other side never completes the transcript: a player
// whose opponent walked away claims the game with a PARTIAL chain padded with
// dummy proofs, waits out a dispute window, and settles. It is the only way
// committed cards ever come back from a game that cannot be settled normally,
// which makes it load-bearing for anything running unattended — a bot cannot
// cancel (cancel is creator-only) and will otherwise strand five cards per
// abandoned game, permanently and monotonically.
//
// Shared with the browser for the same reason as process_game: one flat,
// order-critical argument list, rejected only on-chain if it is wrong.
// ---------------------------------------------------------------------------

/** Blocks that must elapse between claim and settle (contract-enforced). */
/** Mirrors DISPUTE_SECONDS in the game contract. */
export const DISPUTE_SECONDS = 600;

export interface ClaimAbandonedInputs {
  Fr: any;
  onChainGameId: string;
  callerIsPlayer1: boolean;
  handVk: Uint8Array;
  moveVk: Uint8Array;
  dummyVk: Uint8Array;
  handProof1: { proof: string; publicInputs: string[] };
  handProof2: { proof: string; publicInputs: string[] };
  /** The moves that DID complete — 0..9 of them, in any order. */
  validMoveProofs: { proof: string; publicInputs: string[]; startStateHash: string; endStateHash: string }[];
  /** Generates one dummy proof, base64-encoded, to pad the chain. */
  makeDummyProof: () => Promise<string>;
}

/**
 * Build the ordered `claim_abandoned_game` argument list.
 *
 * The real moves are chained exactly as in `process_game` and the remaining
 * slots are filled with dummy proofs carrying all-zero public inputs; the
 * contract verifies the first `num_valid_moves` against the move VK and the
 * rest against the dummy VK. `num_valid_moves` must therefore match the number
 * of real proofs exactly.
 */
export async function buildClaimAbandonedArgs(inputs: ClaimAbandonedInputs): Promise<unknown[]> {
  const { toFr, bytesToFrArray, base64ToFrArray, hexToFr } = await import('./fieldUtils');
  const { Fr } = inputs;
  const toFrArr = (b64: string) => base64ToFrArray(Fr, b64);
  const toFrHex = (hex: string) => hexToFr(Fr, hex);

  const numValid = inputs.validMoveProofs.length;
  if (numValid > TOTAL_MOVES) {
    throw new Error(
      `claim_abandoned_game takes 0..${TOTAL_MOVES} valid move proofs, got ${numValid}`,
    );
  }
  // A COMPLETE chain (nine) is a legal claim, and the important one: a game
  // that ran to the end and whose winner then vanished is the case where the
  // whole transcript exists and settlement is provably owed. This used to
  // throw, because the contract capped n at 8 — it no longer does, and the
  // contract skips the turn-parity check when n == 9 precisely because a
  // finished game has nobody whose turn it is.
  // ZERO is valid: a player can abandon between joining and their first move,
  // and refusing that claim leaves both hands locked with no route back. The
  // contract restricts a zero-move claim to player 2 — the party that did not
  // fail to move — via its "it must be the opponent's turn" check.

  const sorted = sortProofChain(inputs.validMoveProofs, numValid, await computeCanonicalInitialHash());
  const allProofs: unknown[] = sorted.map(m => toFrArr(m.proof));
  const allInputs: unknown[] = sorted.map(m => m.publicInputs.map(toFrHex));
  const zeroInputs = ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0'];
  for (let i = numValid; i < TOTAL_MOVES; i++) {
    allProofs.push(toFrArr(await inputs.makeDummyProof()));
    allInputs.push(zeroInputs.map(toFrHex));
  }

  return [
    toFr(Fr, inputs.onChainGameId),
    new Fr(BigInt(numValid)),
    inputs.callerIsPlayer1,
    bytesToFrArray(Fr, inputs.handVk),
    bytesToFrArray(Fr, inputs.moveVk),
    bytesToFrArray(Fr, inputs.dummyVk),
    toFrArr(inputs.handProof1.proof), inputs.handProof1.publicInputs.map(toFrHex),
    toFrArr(inputs.handProof2.proof), inputs.handProof2.publicInputs.map(toFrHex),
    allProofs[0], allInputs[0], allProofs[1], allInputs[1], allProofs[2], allInputs[2],
    allProofs[3], allInputs[3], allProofs[4], allInputs[4], allProofs[5], allInputs[5],
    allProofs[6], allInputs[6], allProofs[7], allInputs[7], allProofs[8], allInputs[8],
  ];
}

export interface SettleAbandonedInputs {
  Fr: any;
  onChainGameId: string;
  myCardIds: number[];
  myRandomness: string[];
  /** Proves the ids being re-minted are the ones this player committed. */
  myBlinding: string;
}

/**
 * Build the ordered `settle_abandoned_game` argument list.
 *
 * Recovers only YOUR OWN stake. There is no claimed card and no opponent data:
 * the absent player's ids cannot be verified — that binding needs their
 * blinding factor and they are not there to reveal it — so minting anything on
 * their behalf meant minting whatever the claimant asserted. They recover their
 * own five cards themselves, whenever they come back.
 */
export function buildSettleAbandonedArgs(inputs: SettleAbandonedInputs): Promise<unknown[]> {
  return (async () => {
    const { toFr } = await import('./fieldUtils');
    const { Fr } = inputs;
    return [
      toFr(Fr, inputs.onChainGameId),
      padToHand(Fr, inputs.myCardIds),
      inputs.myRandomness.map(v => toFr(Fr, v)),
      toFr(Fr, inputs.myBlinding),
    ];
  })();
}

/**
 * Wait out the dispute window on the CHAIN's clock.
 *
 * This used to count blocks, for a good reason that has since stopped being
 * true: the contract compared block heights, and a wall-clock sleep settles
 * early on a slow chain. The contract now compares TIMESTAMPS, and block rate
 * is not a clock — measured on this testnet it ranges from 27 to 72 seconds,
 * so a five-block wait is anywhere from two to six minutes against a ten-minute
 * window. Production duly failed with "Dispute window not elapsed" after doing
 * all the proving work.
 *
 * So: poll the chain's own timestamp and compare it against the claim's. Immune
 * to block-rate variance and to local clock skew, which a wall-clock sleep is
 * not. Fails loudly at the ceiling rather than waiting forever.
 */
export async function waitForDisputeWindow(
  node: {
    getBlockNumber: () => Promise<number | bigint>;
    getBlock: (n: number) => Promise<any>;
  },
  claimedAtSeconds: number,
  opts: { maxMs?: number; pollMs?: number; onProgress?: (secondsLeft: number) => void } = {},
): Promise<void> {
  const maxMs = opts.maxMs ?? 30 * 60 * 1000;
  const pollMs = opts.pollMs ?? 5000;
  const started = Date.now();

  const chainNow = async (): Promise<number> => {
    const height = Number(await node.getBlockNumber());
    const block = await node.getBlock(height);
    return Number(block?.header?.globalVariables?.timestamp ?? 0);
  };

  for (;;) {
    const now = await chainNow();
    const elapsed = now - claimedAtSeconds;
    if (elapsed >= DISPUTE_SECONDS) return;
    if (Date.now() - started > maxMs) {
      throw new Error(
        `Dispute window did not open: ${elapsed}/${DISPUTE_SECONDS}s of chain time in ` +
        `${Math.round((Date.now() - started) / 1000)}s of ours. ` +
        `Refusing to settle early or wait indefinitely.`,
      );
    }
    opts.onProgress?.(Math.max(0, DISPUTE_SECONDS - elapsed));
    await new Promise(r => setTimeout(r, pollMs));
  }
}
