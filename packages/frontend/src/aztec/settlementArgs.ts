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
  ];
}
