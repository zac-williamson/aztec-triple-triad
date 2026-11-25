/**
 * The private-games protocol's pure core (docs/plan/PRIVATE_GAMES.md).
 *
 * A game leaves no public state. Each player's commit returns a RECORD of
 * opaque hashes; the game's progress is a set of nullifiers only its two
 * players can compute (`Game.game_nullifiers`); settlement releases notes each
 * player prepared for themselves, and each player imports only their own.
 *
 * Everything here is pure — no SDK, no React, no network — so the browser and
 * the bot can share it and the rules can be tested exhaustively:
 *
 *   - records and per-game secrets, parsed and normalised;
 *   - the game's state from its nullifier lookups, and where the abandonment
 *     protocol stands (who may claim, contest or finalize, against which block);
 *   - the transcript's winner and the prize move (a card the LOSER placed);
 *   - which of a player's own prepared notes to import after a resolution.
 */
import type { MoveProofData } from '../types';
import { CARDS_PER_HAND, GAME_TOKEN_REWARD, TOTAL_MOVES } from './gameConstants';

// ─── Field elements ─────────────────────────────────────────────────────────

/** The BN254 scalar field modulus — every game value is an element of it. */
export const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/**
 * Canonical form of a field element: `0x` + 64 lowercase hex digits.
 *
 * Simulate results stringify as DECIMAL (ground rule 8) and Fr as padded hex,
 * so anything compared or persisted goes through here first. Throws on
 * anything that is not a field element — records and payloads come from the
 * opponent and must not be trusted to be well formed.
 */
export function normalizeField(value: unknown): string {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`not a field element: ${value}`);
    n = BigInt(value);
  } else if (value !== null && value !== undefined) {
    const s = String(value).trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) throw new Error(`not a field element: ${s.slice(0, 80)}`);
    n = BigInt(s);
  } else {
    throw new Error('not a field element: (missing)');
  }
  if (n < 0n || n >= FIELD_MODULUS) throw new Error(`not a field element (out of range): 0x${n.toString(16)}`);
  return '0x' + n.toString(16).padStart(64, '0');
}

export const ZERO_FIELD = normalizeField(0n);

// ─── Records ────────────────────────────────────────────────────────────────

/** `[seat, hand_commit, ret_0..ret_4, prize_partial, reward_note_hash]`. */
export type GameRecord = string[];

export const RECORD_LEN = 9;
export const RECORD_SEAT = 0;
export const RECORD_HAND = 1;
export const RECORD_RETURNS = 2;
export const RECORD_PRIZE = 7;
export const RECORD_REWARD = 8;

/** What `game_nullifiers` takes for record_2 before anyone has joined. */
export const ZERO_RECORD: GameRecord = Array.from({ length: RECORD_LEN }, () => ZERO_FIELD);

/** Parse (and normalise) a record — from a simulate result or a PEER payload. */
export function parseRecord(values: unknown): GameRecord {
  if (!Array.isArray(values) || values.length !== RECORD_LEN) {
    throw new Error(`a game record has ${RECORD_LEN} fields, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  const record = values.map(normalizeField);
  if (record[RECORD_SEAT] === ZERO_FIELD || record[RECORD_HAND] === ZERO_FIELD) {
    throw new Error('a game record has no seat or hand commitment');
  }
  return record;
}

export function sameRecord(a: GameRecord | null | undefined, b: GameRecord | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => normalizeField(v) === normalizeField(b[i]));
}

/** The hand commitment the move circuit binds: `Poseidon2([card_ids, blinding])`. */
export function handCommitOf(record: GameRecord): string {
  return record[RECORD_HAND];
}

// ─── Per-game secrets ───────────────────────────────────────────────────────

/**
 * A player's secrets for one game, from `NFT.compute_game_secrets(nonce)`,
 * which returns `[blinding, r_0..r_4, prize_randomness, reward_randomness]`.
 * They never leave the device.
 */
export interface GameSecrets {
  /** Hand blinding factor: the move circuit's private input. */
  blinding: string;
  /** Randomness of the return note for hand slot i. */
  returns: string[];
  /** Randomness of the prize partial note (`w`). */
  prize: string;
  /** Randomness of the reward note (`u`). */
  reward: string;
}

export function parseGameSecrets(values: unknown): GameSecrets {
  if (!Array.isArray(values) || values.length < 8) {
    throw new Error(`compute_game_secrets returns 8 fields, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  const f = values.slice(0, 8).map(normalizeField);
  return { blinding: f[0], returns: f.slice(1, 6), prize: f[6], reward: f[7] };
}

// ─── Nullifier state ────────────────────────────────────────────────────────

export type Side = 1 | 2;
export type ClaimNo = 1 | 2 | 3;
export const MAX_CLAIMS = 3;
export const CLAIM_NUMBERS: readonly ClaimNo[] = [1, 2, 3];

/**
 * Positions in `Game.game_nullifiers`' result: `[created, seat2, joined, done,
 * claim_slot(1..3), claim(1,1), claim(1,2), claim(2,1), claim(2,2), claim(3,1),
 * claim(3,2), contested_by(1), contested_by(2), contest(1..3), resolved(1..3)]`.
 */
export const GAME_NULLIFIER_COUNT = 21;
export const NULLIFIER_INDEX = {
  created: 0,
  seat2: 1,
  joined: 2,
  done: 3,
  claimSlot: (c: ClaimNo) => 3 + c,
  claim: (c: ClaimNo, side: Side) => 7 + (c - 1) * 2 + (side - 1),
  contestedBy: (side: Side) => 12 + side,
  contest: (c: ClaimNo) => 14 + c,
  resolved: (c: ClaimNo) => 17 + c,
} as const;

/** A nullifier the node found, and the block it landed in. */
export interface NullifierHit {
  blockNumber: number;
}

/** One game's on-chain state, read from its nullifiers. */
export interface GameChainState {
  created: NullifierHit | null;
  /** Seat 2 closed: by a join, or by the creator cancelling. */
  seat2: NullifierHit | null;
  /** The joiner's record is committed. Meaningless without the real record_2. */
  joined: NullifierHit | null;
  /** Resolved: settled, unwound or cancelled. At most once. */
  done: NullifierHit | null;
  /** Index c-1. */
  claimSlots: (NullifierHit | null)[];
  /** Index [c-1][side-1]: who filed claim c, and when. */
  claims: (NullifierHit | null)[][];
  /** Index side-1: each side contests at most once. */
  contestedBy: (NullifierHit | null)[];
  /** Index c-1: claim c was contested (restarts the clock). */
  contests: (NullifierHit | null)[];
  /** Index c-1: claim c was contested or finalized. */
  resolved: (NullifierHit | null)[];
}

/** Build the state from the 21 lookups, in `game_nullifiers` order. */
export function parseGameChainState(hits: (NullifierHit | null | undefined)[]): GameChainState {
  if (hits.length !== GAME_NULLIFIER_COUNT) {
    throw new Error(`expected ${GAME_NULLIFIER_COUNT} nullifier lookups, got ${hits.length}`);
  }
  const at = (i: number): NullifierHit | null => hits[i] ?? null;
  return {
    created: at(NULLIFIER_INDEX.created),
    seat2: at(NULLIFIER_INDEX.seat2),
    joined: at(NULLIFIER_INDEX.joined),
    done: at(NULLIFIER_INDEX.done),
    claimSlots: CLAIM_NUMBERS.map(c => at(NULLIFIER_INDEX.claimSlot(c))),
    claims: CLAIM_NUMBERS.map(c => [at(NULLIFIER_INDEX.claim(c, 1)), at(NULLIFIER_INDEX.claim(c, 2))]),
    contestedBy: [at(NULLIFIER_INDEX.contestedBy(1)), at(NULLIFIER_INDEX.contestedBy(2))],
    contests: CLAIM_NUMBERS.map(c => at(NULLIFIER_INDEX.contest(c))),
    resolved: CLAIM_NUMBERS.map(c => at(NULLIFIER_INDEX.resolved(c))),
  };
}

/**
 * Where the abandonment protocol stands. Times are not here — they come from
 * block headers — only which action is possible and against which block:
 *
 *   - `can-claim`: claim `claimNo` may be filed once the chain is
 *     MIN_ABANDON_SECONDS past `clockBlock` (the join for claim 1, the
 *     previous contest after that). `clockBlock` is what the contract takes.
 *   - `open-claim`: claim `claimNo` by `claimSide` stands. The other side may
 *     contest it before `claimBlock`'s time + DISPUTE_SECONDS (passing
 *     `claimBlock - 1` as the block where it did not yet exist); anyone may
 *     finalize it after that, passing `claimBlock`.
 */
export type AbandonmentPosition =
  | { kind: 'not-joined' }
  | { kind: 'done' }
  | { kind: 'can-claim'; claimNo: ClaimNo; clockBlock: number }
  | { kind: 'open-claim'; claimNo: ClaimNo; claimSide: Side; claimBlock: number }
  | { kind: 'no-claims-left' };

export function abandonmentPosition(state: GameChainState): AbandonmentPosition {
  if (state.done) return { kind: 'done' };
  if (!state.joined) return { kind: 'not-joined' };

  // Claims are sequential: claim c needs claim c-1's contest as its clock.
  let latest = 0;
  for (const c of CLAIM_NUMBERS) if (state.claimSlots[c - 1]) latest = c;
  if (latest === 0) return { kind: 'can-claim', claimNo: 1, clockBlock: state.joined.blockNumber };

  const c = latest as ClaimNo;
  if (!state.resolved[c - 1]) {
    const [bySide1, bySide2] = state.claims[c - 1];
    const filed = bySide1 ?? bySide2;
    // A claim slot and its claim nullifier are pushed by the same tx.
    if (!filed) throw new Error(`claim ${c} is taken but nobody filed it — inconsistent nullifier reads`);
    return { kind: 'open-claim', claimNo: c, claimSide: bySide1 ? 1 : 2, claimBlock: filed.blockNumber };
  }
  const contest = state.contests[c - 1];
  // Resolved without a contest means finalized, which also pushes `done`;
  // seeing one without the other is a read that straddled the tx.
  if (!contest) return { kind: 'done' };
  if (c >= MAX_CLAIMS) return { kind: 'no-claims-left' };
  return { kind: 'can-claim', claimNo: (c + 1) as ClaimNo, clockBlock: contest.blockNumber };
}

/** Whether `side` has already used its one contest. */
export function hasContested(state: GameChainState, side: Side): boolean {
  return !!state.contestedBy[side - 1];
}

// ─── Transcript, winner and prize ───────────────────────────────────────────

/** The card a move placed and its slot in the mover's committed hand. */
export function placedOf(proof: MoveProofData): { cardId: number; slot: number } {
  const cardId = proof.placedCardId ?? Number(BigInt(proof.publicInputs[6] ?? '0'));
  const slot = proof.placedSlot ?? Number(BigInt(proof.publicInputs[7] ?? '0'));
  return { cardId, slot };
}

/** The player who makes move `index`: player 1 at even indices, player 2 at odd. */
export function moverOf(index: number): Side {
  return index % 2 === 0 ? 1 : 2;
}

/**
 * Order move proofs by chaining each end state to the next start state.
 *
 * Pure: it finds the head as the one proof whose start no other proof ends
 * in. Settlement still checks the head against the canonical empty board
 * (`sortProofChain`); this is for reading the transcript, not proving it.
 */
export function orderTranscript(proofs: MoveProofData[]): MoveProofData[] {
  const byStart = new Map<string, MoveProofData>();
  const ends = new Set<string>();
  for (const p of proofs) {
    byStart.set(p.startStateHash, p);
    ends.add(p.endStateHash);
  }
  const heads = [...byStart.values()].filter(p => !ends.has(p.startStateHash));
  if (heads.length !== 1) throw new Error(`a transcript has one first move, found ${heads.length}`);
  const ordered: MoveProofData[] = [];
  let next: MoveProofData | undefined = heads[0];
  while (next && ordered.length < proofs.length) {
    ordered.push(next);
    next = byStart.get(next.endStateHash);
  }
  return ordered;
}

export type Winner = Side | 'draw';

/** The result the ninth move proves (winner_id 1, 2 or 3 = draw). */
export function winnerOf(ordered: MoveProofData[]): Winner {
  if (ordered.length < TOTAL_MOVES) throw new Error(`the result needs all ${TOTAL_MOVES} moves, have ${ordered.length}`);
  const last = ordered[TOTAL_MOVES - 1];
  if (!last.gameEnded) throw new Error('the ninth move does not end the game');
  if (last.winnerId === 1 || last.winnerId === 2) return last.winnerId;
  if (last.winnerId === 3) return 'draw';
  throw new Error(`the ninth move names no winner (winner_id ${last.winnerId})`);
}

export function loserOf(winner: Side): Side {
  return winner === 1 ? 2 : 1;
}

/** Indices of the moves the loser made — the only legal prize moves. */
export function loserMoveIndices(winner: Side): number[] {
  const loser = loserOf(winner);
  return Array.from({ length: TOTAL_MOVES }, (_, i) => i).filter(i => moverOf(i) === loser);
}

/**
 * The move index that placed `cardId` for the loser — what `settle_game`
 * takes as `prize_move`. A hand never holds the same id twice, so within the
 * loser's own moves the card names exactly one. The winner may have placed
 * the same id from their own hand, which is why only the loser's parity is
 * searched.
 */
export function prizeMoveForCard(ordered: MoveProofData[], winner: Side, cardId: number): number {
  for (const i of loserMoveIndices(winner)) {
    if (ordered[i] && placedOf(ordered[i]).cardId === cardId) return i;
  }
  throw new Error(`card ${cardId} was not placed by the loser — the prize must be one of their placed cards`);
}

/**
 * The default prize: the loser's strongest placed card (ties: the earliest
 * move). Used whenever nobody picked — an auto-settle, or a settle by the
 * loser on behalf of an absent winner, who should not get to keep their best
 * card by being the one to press the button.
 */
export function defaultPrizeMove(
  ordered: MoveProofData[],
  winner: Side,
  strength: (cardId: number) => number,
): number {
  let best = -1;
  let bestStrength = -Infinity;
  for (const i of loserMoveIndices(winner)) {
    const proof = ordered[i];
    if (!proof) continue;
    const s = strength(placedOf(proof).cardId);
    if (s > bestStrength) { best = i; bestStrength = s; }
  }
  if (best < 0) throw new Error('the loser placed no cards — there is no prize to take');
  return best;
}

/** The card and loser hand slot a prize move takes. */
export function prizeOfMove(ordered: MoveProofData[], winner: Side, prizeMove: number): { cardId: number; slot: number } {
  if (!Number.isInteger(prizeMove) || prizeMove < 0 || prizeMove >= TOTAL_MOVES) {
    throw new Error(`prize move out of range: ${prizeMove}`);
  }
  if (moverOf(prizeMove) !== loserOf(winner)) {
    throw new Error(`move ${prizeMove} was the winner's — the prize must be a card the loser placed`);
  }
  const proof = ordered[prizeMove];
  if (!proof) throw new Error(`no proof for move ${prizeMove}`);
  const placed = placedOf(proof);
  if (placed.slot < 0 || placed.slot >= CARDS_PER_HAND) throw new Error(`prize slot out of range: ${placed.slot}`);
  return placed;
}

// ─── What to import ─────────────────────────────────────────────────────────

/**
 * How a game was resolved, as far as one player's own notes are concerned.
 *
 *   - `settled`: settle_game. Every return but the loser's prize slot, the
 *     winner's prize, and both rewards.
 *   - `unwound`: finalize_abandoned_game of a claim that took nothing. All
 *     ten returns, no rewards.
 *   - `forfeited`: finalize_abandoned_game of a claim that took an open card.
 *     The claimant's five returns and that card (as their prize note), the
 *     other player's four other returns; no rewards.
 *   - `cancelled`: cancel_game. The creator's five returns.
 */
export type Resolution =
  | { kind: 'settled'; winner: Winner; prize?: { cardId: number; slot: number } }
  | { kind: 'unwound' }
  | { kind: 'forfeited'; claimSide: Side; card: { cardId: number; slot: number } }
  | { kind: 'cancelled' };

export interface OwnNote {
  tokenId: number;
  randomness: string;
  kind: 'return' | 'prize';
  /** Hand slot, for a return. */
  slot?: number;
}

export interface OwnImport {
  cards: OwnNote[];
  reward: { amount: number; randomness: string } | null;
  /** The loser's card the winner took, when this player is the loser. */
  takenCardId: number | null;
}

/**
 * Exactly the notes this player's own data can import after `resolution`.
 *
 * Each note is rebuilt from the player's own hand and secrets — nothing from
 * the opponent — and `import_note` checks it against the tx, so a wrong guess
 * imports nothing rather than something false. A winner whose prize is not
 * known (they did not settle and were not told) gets no prize entry here; the
 * caller decides how to recover it.
 */
export function selectOwnNotes(opts: {
  role: Side;
  hand: number[];
  secrets: GameSecrets;
  resolution: Resolution;
}): OwnImport {
  const { role, hand, secrets, resolution } = opts;
  if (hand.length !== CARDS_PER_HAND) throw new Error(`a hand is ${CARDS_PER_HAND} cards, got ${hand.length}`);
  const returns = (skipSlot: number | null): OwnNote[] => hand
    .map((tokenId, slot) => ({ tokenId, randomness: secrets.returns[slot], kind: 'return' as const, slot }))
    .filter(n => n.slot !== skipSlot);

  if (resolution.kind === 'cancelled') {
    // Only the creator committed anything to a cancelled game.
    return { cards: role === 1 ? returns(null) : [], reward: null, takenCardId: null };
  }
  if (resolution.kind === 'unwound') {
    return { cards: returns(null), reward: null, takenCardId: null };
  }
  if (resolution.kind === 'forfeited') {
    if (resolution.claimSide === role) {
      // We stayed: our five back, and the leaver's card on our prize partial.
      const cards = returns(null);
      cards.push({ tokenId: resolution.card.cardId, randomness: secrets.prize, kind: 'prize' });
      return { cards, reward: null, takenCardId: null };
    }
    // We left: the claim took the card in that slot of our hand.
    return { cards: returns(resolution.card.slot), reward: null, takenCardId: hand[resolution.card.slot] ?? null };
  }

  const reward = { amount: GAME_TOKEN_REWARD, randomness: secrets.reward };
  if (resolution.winner === 'draw') return { cards: returns(null), reward, takenCardId: null };
  if (resolution.winner === role) {
    const cards = returns(null);
    if (resolution.prize) {
      cards.push({ tokenId: resolution.prize.cardId, randomness: secrets.prize, kind: 'prize' });
    }
    return { cards, reward, takenCardId: null };
  }
  if (!resolution.prize) throw new Error('the loser cannot tell which return note was withheld without the prize slot');
  return {
    cards: returns(resolution.prize.slot),
    reward,
    takenCardId: hand[resolution.prize.slot] ?? null,
  };
}

/**
 * Read a resolution off which of this player's prepared notes a tx released —
 * for when nobody said what the tx was (the settler vanished, or the game was
 * unwound or cancelled while this player was away).
 *
 * `returns[i]` is whether the return note of hand slot i is in the tx,
 * `reward` whether this player's reward note is. A settlement always
 * releases both rewards; an abandonment or a cancel never does.
 *
 * Without a reward, four returns means this player walked away and a claim
 * took the fifth. Five can be an unwind, a cancel, or a forfeit THIS player
 * claimed — its prize note is not one of our prepared hashes, so this cannot
 * tell; the caller reads the claim's terms (`claimTermsOf`) for that.
 */
export function resolutionFromReleased(opts: {
  role: Side;
  /** This player's committed hand: the withheld slot names the card taken. */
  hand: number[];
  returns: boolean[];
  reward: boolean;
  /** The transcript's winner, when this player holds all nine moves. */
  winner: Winner | null;
  /** Whether a second player ever joined (a cancel has no joiner). */
  joined: boolean;
}): Resolution {
  const { role, hand, returns, reward, winner, joined } = opts;
  const released = returns.filter(Boolean).length;
  if (released === 0) throw new Error('none of this player\'s return notes are in the tx — it is not this game\'s resolution');

  if (!reward) {
    if (released === CARDS_PER_HAND) return joined ? { kind: 'unwound' } : { kind: 'cancelled' };
    if (joined && released === CARDS_PER_HAND - 1) {
      const slot = returns.findIndex(r => !r);
      const claimSide: Side = role === 1 ? 2 : 1;
      return { kind: 'forfeited', claimSide, card: { cardId: hand[slot], slot } };
    }
    throw new Error(`an abandonment returns all ${CARDS_PER_HAND} cards or all but one, the tx released ${released}`);
  }
  if (released === CARDS_PER_HAND) {
    // A draw or a win look the same from one's own returns. The transcript
    // says which; without it a win's prize simply is not imported here.
    if (winner === role) return { kind: 'settled', winner: role };
    return { kind: 'settled', winner: 'draw' };
  }
  if (released !== CARDS_PER_HAND - 1) throw new Error(`a settlement withholds at most one return, the tx released ${released}`);
  const slot = returns.findIndex(r => !r);
  return { kind: 'settled', winner: loserOf(role), prize: { cardId: hand[slot], slot } };
}
