/**
 * Test fixtures for the private-games protocol: transcripts with the real
 * shape (8 public inputs, chained state hashes, the placed card and slot),
 * records and secrets. Not a test file — imported by the tests.
 */
import type { MoveProofData } from '../../types';
import { normalizeField, type GameChainState, type GameRecord, type GameSecrets, type NullifierHit } from '../privateGame';
import type { TranscriptMove } from '../localGame';

export const P1_HAND = [11, 12, 13, 14, 15];
export const P2_HAND = [21, 22, 23, 24, 25];

const hex = (n: number | bigint) => normalizeField(BigInt(n));

/** A field-shaped hash for state i. */
export const stateHash = (i: number) => hex(0x5000n + BigInt(i));

/**
 * A full nine-move transcript. Player 1 places its hand in order at moves
 * 0,2,4,6,8; player 2 places its first four at 1,3,5,7 (its fifth stays
 * unplayed). `p2Order` lets a test place player 2's cards in a different
 * order (slot indices still refer to the committed hand).
 */
export function transcript(opts: {
  winner: 1 | 2 | 3;
  p1Hand?: number[];
  p2Hand?: number[];
  p2Order?: number[];
  commit1?: string;
  commit2?: string;
}): MoveProofData[] {
  const p1 = opts.p1Hand ?? P1_HAND;
  const p2 = opts.p2Hand ?? P2_HAND;
  const p2Order = opts.p2Order ?? [0, 1, 2, 3];
  const commit1 = opts.commit1 ?? hex(0xc1);
  const commit2 = opts.commit2 ?? hex(0xc2);
  const proofs: MoveProofData[] = [];
  for (let i = 0; i < 9; i++) {
    const p1Move = i % 2 === 0;
    const slot = p1Move ? i / 2 : p2Order[(i - 1) / 2];
    const cardId = p1Move ? p1[slot] : p2[slot];
    const last = i === 8;
    const publicInputs = [
      commit1, commit2, stateHash(i), stateHash(i + 1),
      hex(last ? 1 : 0), hex(last ? opts.winner : 0), hex(cardId), hex(slot),
    ];
    proofs.push({
      proof: btoa('proof-' + i),
      publicInputs,
      cardCommit1: commit1,
      cardCommit2: commit2,
      startStateHash: stateHash(i),
      endStateHash: stateHash(i + 1),
      gameEnded: last,
      winnerId: last ? opts.winner : 0,
      placedCardId: cardId,
      placedSlot: slot,
    });
  }
  return proofs;
}

/** A transcript as stored: each proof with the move it proves (one cell per move). */
export function linksOf(proofs: MoveProofData[]): TranscriptMove[] {
  return proofs.map((proof, i) => ({
    moveNumber: i, cardId: proof.placedCardId!, slot: proof.placedSlot!, row: Math.floor(i / 3), col: i % 3, proof,
  }));
}

/** A record whose fields are distinct, recognisable field elements. */
export function record(tag: number): GameRecord {
  return Array.from({ length: 9 }, (_, i) => hex(BigInt(tag) * 0x100n + BigInt(i + 1)));
}

export function secrets(tag = 1): GameSecrets {
  return {
    blinding: hex(0xb0 + tag),
    returns: [0, 1, 2, 3, 4].map(i => hex(0x1000 * tag + i)),
    prize: hex(0x2000 * tag + 0xf),
    reward: hex(0x3000 * tag + 0xe),
  };
}

/** A chain state with only the named nullifiers present. */
export function chainState(hits: Partial<{
  created: number; seat2: number; joined: number; done: number;
  claimSlots: (number | null)[];
  claims: [number | null, number | null][];
  contestedBy: (number | null)[];
  contests: (number | null)[];
  resolved: (number | null)[];
}>): GameChainState {
  const hit = (b: number | null | undefined): NullifierHit | null => (b === null || b === undefined ? null : { blockNumber: b });
  const three = (a?: (number | null)[]) => [0, 1, 2].map(i => hit(a?.[i]));
  return {
    created: hit(hits.created),
    seat2: hit(hits.seat2),
    joined: hit(hits.joined),
    done: hit(hits.done),
    claimSlots: three(hits.claimSlots),
    claims: [0, 1, 2].map(i => [hit(hits.claims?.[i]?.[0]), hit(hits.claims?.[i]?.[1])]),
    contestedBy: [hit(hits.contestedBy?.[0]), hit(hits.contestedBy?.[1])],
    contests: three(hits.contests),
    resolved: three(hits.resolved),
  };
}
