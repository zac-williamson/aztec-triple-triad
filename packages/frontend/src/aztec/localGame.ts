/**
 * The game, run by each client (docs/plan/PRIVATE_GAMES.md section 6.2).
 *
 * The relay no longer holds a board or a hand, so each player rebuilds the
 * game from what they know:
 *
 *   - their own five cards, in the order they were committed;
 *   - the opponent's three OPEN cards (hand slots 0..2), once proven
 *     (OPEN_CARDS); until then the whole opposing hand is face down;
 *   - the moves, each naming the card, its slot in the mover's committed hand
 *     and the cell. A move from a hidden slot reveals that card.
 *
 * Replaying the moves through `packages/game-logic` gives the board, turn,
 * scores and result. A score is board cells owned plus cards left in hand,
 * and the hand count is known even where the cards are not — so a face-down
 * placeholder counts, and both players compute the same scores (they enter
 * the state hashes the move proofs chain on).
 *
 * Pure: no SDK, no React, no network. Proof checks live in moveChecks.ts.
 */
import { createGame, getCardById, placeCard } from '@axolotl-arena/game-logic';
import type { Board, Card, GameState, MoveProofData, Player } from '../types';
import { CARDS_PER_HAND, TOTAL_MOVES } from './gameConstants';
import { moverOf, normalizeField, type Side } from './privateGame';

/** Triple Triad's "three open": each hand's first three committed slots are shown. */
export const OPEN_CARD_COUNT = 3;
/** Public inputs of the open-cards proof: `[hand_commit, open_0, open_1, open_2]`. */
export const OPEN_CARDS_PUBLIC_INPUTS = 1 + OPEN_CARD_COUNT;
/** Public inputs of a game_move proof (section 4). */
export const MOVE_PROOF_PUBLIC_INPUTS = 8;
/** The largest proof (base64 characters) a peer payload may carry. */
export const MAX_PROOF_LENGTH = 200_000;
/** Card ids are 1..256 (`commit_hand` checks this on-chain). */
export const MAX_CARD_ID = 256;

/** The id a card the player may not see carries: the UI shows it face down. */
export const HIDDEN_CARD_ID = 0;

export function hiddenCard(): Card {
  return { id: HIDDEN_CARD_ID, name: 'Hidden', ranks: { top: 0, right: 0, bottom: 0, left: 0 } };
}

export function isHiddenCard(card: Card): boolean {
  return card.id === HIDDEN_CARD_ID;
}

/** Whether a hand slot is one of the three the opponent sees from the start. */
export function isOpenSlot(slot: number): boolean {
  return slot < OPEN_CARD_COUNT;
}

export function playerOf(side: Side): Player {
  return side === 1 ? 'player1' : 'player2';
}

export function otherSide(side: Side): Side {
  return side === 1 ? 2 : 1;
}

/** The circuit's `winner_id`: 0 = not ended, 1 = player 1, 2 = player 2, 3 = draw. */
export function winnerIdOf(winner: Player | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3;
}

/** The card with this id, as the rules engine knows it. Throws for an id that is not a card. */
export function cardOf(id: number): Card {
  const card = Number.isInteger(id) && id >= 1 && id <= MAX_CARD_ID ? getCardById(id) : undefined;
  if (!card) throw new Error(`${id} is not a card`);
  return { ...card, ranks: { ...card.ranks } };
}

// ─── Moves and the transcript ───────────────────────────────────────────────

/** One move: the card, its slot in the mover's committed hand, and the cell. */
export interface GameMove {
  /** 0..8: player 1 moves at even numbers, player 2 at odd. */
  moveNumber: number;
  cardId: number;
  slot: number;
  row: number;
  col: number;
}

/** A move and the proof that it was legal: one link of the settlement transcript. */
export interface TranscriptMove extends GameMove {
  proof: MoveProofData;
}

/** Everything the board is rebuilt from. */
export interface LocalGameFacts {
  role: Side;
  /** This player's five card ids, in committed order. */
  ownHand: number[];
  /** The opponent's proven open cards (slots 0..2), or null until OPEN_CARDS checks out. */
  opponentOpen: number[] | null;
  /** The moves so far, in order. */
  moves: GameMove[];
}

export interface Replayed {
  /**
   * The game as this player sees it: hands hold the unplayed slots in slot
   * order — real cards where known, `hiddenCard()` where not.
   */
  state: GameState;
  /** Cells the last move captured. */
  captures: { row: number; col: number }[];
  /** Index [side-1][slot]: the card played from that slot, or null. */
  played: (number | null)[][];
}

function slotCards(facts: LocalGameFacts, side: Side): Card[] {
  if (side === facts.role) return facts.ownHand.map(cardOf);
  return Array.from({ length: CARDS_PER_HAND }, (_, slot) =>
    facts.opponentOpen && isOpenSlot(slot) ? cardOf(facts.opponentOpen[slot]) : hiddenCard());
}

/**
 * Rebuild the game from its facts. Throws if a move does not fit the game so
 * far (out of order, a slot played twice, an occupied cell): callers check a
 * move before adding it, so a throw here means stored facts are corrupt.
 */
export function replay(facts: LocalGameFacts): Replayed {
  if (facts.ownHand.length !== CARDS_PER_HAND) {
    throw new Error(`a hand is ${CARDS_PER_HAND} cards, got ${facts.ownHand.length}`);
  }
  const slots = [slotCards(facts, 1), slotCards(facts, 2)];
  const played: (number | null)[][] = [Array(CARDS_PER_HAND).fill(null), Array(CARDS_PER_HAND).fill(null)];
  const handOf = (side: Side) => slots[side - 1].filter((_, slot) => played[side - 1][slot] === null);

  let state: GameState = createGame(handOf(1), handOf(2));
  let captures: { row: number; col: number }[] = [];
  facts.moves.forEach((m, i) => {
    if (m.moveNumber !== i) throw new Error(`move ${i} is numbered ${m.moveNumber}`);
    const side = moverOf(m.moveNumber);
    if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= CARDS_PER_HAND) {
      throw new Error(`move ${i}: slot ${m.slot} is not a hand slot`);
    }
    if (played[side - 1][m.slot] !== null) throw new Error(`move ${i}: player ${side}'s slot ${m.slot} was already played`);
    // The move reveals its card: a hidden slot becomes real before it is placed.
    slots[side - 1][m.slot] = cardOf(m.cardId);
    const handIndex = played[side - 1].slice(0, m.slot).filter(p => p === null).length;
    const result = placeCard({ ...state, player1Hand: handOf(1), player2Hand: handOf(2) }, playerOf(side), handIndex, m.row, m.col);
    played[side - 1][m.slot] = m.cardId;
    state = result.newState;
    captures = result.captures;
  });
  return { state: { ...state, player1Hand: handOf(1), player2Hand: handOf(2) }, captures, played };
}

/** This side's hand slots not yet played, in slot order — what its hand shows. */
export function unplayedSlots(r: Replayed, side: Side): number[] {
  return r.played[side - 1].flatMap((p, slot) => (p === null ? [slot] : []));
}

/** The move number to come next. */
export function nextMoveNumber(facts: LocalGameFacts): number {
  return facts.moves.length;
}

/**
 * Our move: hand index (as the UI shows the hand) and cell → the move. Throws
 * when it is not ours to make.
 */
export function planOwnMove(facts: LocalGameFacts, r: Replayed, handIndex: number, row: number, col: number): GameMove {
  const { state } = r;
  if (state.status === 'finished') throw new Error('the game is over');
  if (state.currentTurn !== playerOf(facts.role)) throw new Error('it is not your turn');
  const slot = unplayedSlots(r, facts.role)[handIndex];
  if (slot === undefined) throw new Error(`no card at hand index ${handIndex}`);
  if (!onBoard(row) || !onBoard(col)) throw new Error(`(${row}, ${col}) is not a cell`);
  if (state.board[row][col].card !== null) throw new Error(`cell (${row}, ${col}) is occupied`);
  return { moveNumber: nextMoveNumber(facts), cardId: facts.ownHand[slot], slot, row, col };
}

function onBoard(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 2;
}

/**
 * Bounds-check the opponent's move against the game so far (section 6.3,
 * step 1): it is their turn at this number, the slot is theirs and unplayed,
 * the card is the open card proven for that slot (or, for a hidden slot, no
 * card they have already shown), and the cell is empty. Returns why not, or null.
 */
export function opponentMoveProblem(facts: LocalGameFacts, r: Replayed, move: GameMove): string | null {
  const expected = nextMoveNumber(facts);
  if (move.moveNumber !== expected) return `expected move ${expected}, got move ${move.moveNumber}`;
  if (move.moveNumber >= TOTAL_MOVES || r.state.status === 'finished') return 'the game is already over';
  const side = moverOf(move.moveNumber);
  if (side === facts.role) return `move ${move.moveNumber} is ours to make, not the opponent's`;
  if (!Number.isInteger(move.slot) || move.slot < 0 || move.slot >= CARDS_PER_HAND) return `slot ${move.slot} is not a hand slot`;
  const played = r.played[side - 1];
  if (played[move.slot] !== null) return `the opponent already played their slot ${move.slot}`;
  try {
    cardOf(move.cardId);
  } catch {
    return `card ${move.cardId} does not exist`;
  }
  const open = facts.opponentOpen;
  if (open && isOpenSlot(move.slot) && open[move.slot] !== move.cardId) {
    return `slot ${move.slot} holds open card ${open[move.slot]}, but the move plays card ${move.cardId}`;
  }
  // A hand never repeats an id, so a card the opponent has shown at another
  // slot (open, or already played) cannot come out of this one.
  for (let slot = 0; slot < CARDS_PER_HAND; slot++) {
    if (slot === move.slot) continue;
    const shown = played[slot] ?? (open && isOpenSlot(slot) ? open[slot] : null);
    if (shown === move.cardId) return `card ${move.cardId} is the opponent's slot ${slot}, not slot ${move.slot}`;
  }
  if (!onBoard(move.row) || !onBoard(move.col)) return `(${move.row}, ${move.col}) is not a cell`;
  if (r.state.board[move.row][move.col].card !== null) return `cell (${move.row}, ${move.col}) is occupied`;
  return null;
}

/**
 * Do the proven open cards fit what the opponent has already played? (A
 * move may arrive before OPEN_CARDS: its proof alone binds it to the hand.)
 */
export function openCardsProblem(facts: LocalGameFacts, r: Replayed, cards: number[]): string | null {
  if (cards.length !== OPEN_CARD_COUNT) return `open cards are ${OPEN_CARD_COUNT}, got ${cards.length}`;
  if (new Set(cards).size !== cards.length) return 'the open cards repeat a card';
  if (facts.opponentOpen) {
    return facts.opponentOpen.every((c, i) => c === cards[i]) ? null : 'a second, different set of open cards';
  }
  const played = r.played[otherSide(facts.role) - 1];
  for (let slot = 0; slot < CARDS_PER_HAND; slot++) {
    const p = played[slot];
    if (p === null) continue;
    if (isOpenSlot(slot) && cards[slot] !== p) return `the opponent played card ${p} from open slot ${slot}, but the proof shows card ${cards[slot]} there`;
    if (!isOpenSlot(slot) && cards.includes(p)) return `card ${p}, played from hidden slot ${slot}, is also an open card`;
  }
  return null;
}

// ─── The circuit's view of a state ──────────────────────────────────────────

/**
 * Board state as the circuit takes it: 9 cells × [card_id, owner], owner
 * 0 = empty, 1 = player 1, 2 = player 2.
 */
export function encodeBoardState(board: Board): string[] {
  const flat: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = board[r][c];
      flat.push(cell.card ? String(cell.card.id) : '0');
      flat.push(cell.owner === 'player1' ? '1' : cell.owner === 'player2' ? '2' : '0');
    }
  }
  return flat;
}

/**
 * Per-cell ORIGINAL owner (who first placed the card), in the same cell order:
 * 0 = empty, 1 = player 1, 2 = player 2. Publicly agreed — capture changes a
 * cell's `owner` but never its `originalOwner` — and hashed into every state
 * (the C2 round-2 replay guard).
 */
export function encodeOriginalOwners(board: Board): number[] {
  const owners: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const oo = board[r][c].originalOwner;
      owners.push(oo === 'player1' ? 1 : oo === 'player2' ? 2 : 0);
    }
  }
  return owners;
}

/** `computeBoardStateHash`: pedersen over `[board[18], scores[2], turn, original_owners[9]]`. */
export type StateHasher = (board: string[], scores: [number, number], turn: number, originalOwners: number[]) => Promise<string>;

/**
 * The state hashes a move's proof must carry: before it (the mover to play)
 * and after it (the other player to play) — exactly as `generateGameMoveProof`
 * computes them for the mover.
 */
export async function moveStateHashes(
  before: GameState,
  after: GameState,
  mover: Side,
  hash: StateHasher,
): Promise<{ start: string; end: string }> {
  const start = await hash(encodeBoardState(before.board), [before.player1Score, before.player2Score], mover, encodeOriginalOwners(before.board));
  const end = await hash(encodeBoardState(after.board), [after.player1Score, after.player2Score], otherSide(mover), encodeOriginalOwners(after.board));
  return { start, end };
}

export const MOVE_INPUT_NAMES = [
  'card_commit_1', 'card_commit_2', 'start_state_hash', 'end_state_hash',
  'game_ended', 'winner_id', 'placed_card_id', 'placed_slot',
] as const;

/** The public inputs a proof of `move` must carry, given the state after it. */
export function expectedMoveInputs(opts: {
  commit1: string;
  commit2: string;
  hashes: { start: string; end: string };
  after: GameState;
  move: Pick<GameMove, 'cardId' | 'slot'>;
}): string[] {
  const ended = opts.after.status === 'finished';
  return [
    opts.commit1, opts.commit2, opts.hashes.start, opts.hashes.end,
    ended ? 1 : 0, winnerIdOf(ended ? opts.after.winner : null), opts.move.cardId, opts.move.slot,
  ].map(v => normalizeField(v));
}

/** The first public input that differs from what we expect, by name; null if all agree. */
export function publicInputsMismatch(expected: string[], actual: string[], names: readonly string[]): string | null {
  if (actual.length !== expected.length) return `${expected.length} public inputs expected, got ${actual.length}`;
  for (let i = 0; i < expected.length; i++) {
    let a: string;
    try {
      a = normalizeField(actual[i]);
    } catch {
      return `${names[i] ?? `input ${i}`} is not a field element`;
    }
    if (a !== normalizeField(expected[i])) return `${names[i] ?? `input ${i}`} does not match`;
  }
  return null;
}

export const OPEN_CARDS_INPUT_NAMES = ['card_commit_hash', 'open_0', 'open_1', 'open_2'] as const;

export function expectedOpenCardsInputs(handCommit: string, cards: number[]): string[] {
  return [handCommit, ...cards].map(v => normalizeField(v));
}

/**
 * Read a game_move proof's 8 public inputs: `[card_commit_1, card_commit_2,
 * start_state_hash, end_state_hash, game_ended, winner_id, placed_card_id,
 * placed_slot]`. A received proof is always rebuilt this way — its convenience
 * fields are never taken from the sender.
 */
export function moveProofFromOutput(proof: string, publicInputs: string[], durationMs?: number): MoveProofData {
  if (publicInputs.length !== MOVE_PROOF_PUBLIC_INPUTS) {
    throw new Error(`game_move: expected ${MOVE_PROOF_PUBLIC_INPUTS} public inputs, got ${publicInputs.length}`);
  }
  return {
    proof,
    publicInputs,
    cardCommit1: publicInputs[0],
    cardCommit2: publicInputs[1],
    startStateHash: publicInputs[2],
    endStateHash: publicInputs[3],
    gameEnded: BigInt(publicInputs[4]) !== 0n,
    winnerId: Number(BigInt(publicInputs[5])),
    placedCardId: Number(BigInt(publicInputs[6])),
    placedSlot: Number(BigInt(publicInputs[7])),
    durationMs,
  };
}

// ─── Sealed payloads ────────────────────────────────────────────────────────

/** A MOVE's sealed body (section 6.1). */
export interface MovePayload {
  cardId: number;
  slot: number;
  row: number;
  col: number;
  /** The game_move proof, base64. */
  proof: string;
  /** Its 8 public inputs, canonical hex. */
  publicInputs: string[];
}

/** OPEN_CARDS' body: the three open cards and the proof they are the committed hand's slots 0..2. */
export interface OpenCardsPayload {
  cards: number[];
  /** The open-cards (prove_hand) proof, base64. */
  proof: string;
  /** `[hand_commit, open_0, open_1, open_2]`, canonical hex. */
  publicInputs: string[];
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function intIn(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what} must be an integer ${min}..${max}, got ${String(value).slice(0, 40)}`);
  }
  return value;
}

function proofString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROOF_LENGTH || !BASE64.test(value)) {
    throw new Error('the proof is not base64 of a plausible size');
  }
  return value;
}

function fieldList(value: unknown, length: number): string[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`expected ${length} public inputs, got ${Array.isArray(value) ? value.length : typeof value}`);
  }
  return value.map(normalizeField);
}

/** Validate an opened MOVE body. Throws on anything malformed. */
export function parseMovePayload(raw: unknown): MovePayload {
  if (!raw || typeof raw !== 'object') throw new Error('move payload is not an object');
  const p = raw as Record<string, unknown>;
  return {
    cardId: intIn(p.cardId, 1, MAX_CARD_ID, 'cardId'),
    slot: intIn(p.slot, 0, CARDS_PER_HAND - 1, 'slot'),
    row: intIn(p.row, 0, 2, 'row'),
    col: intIn(p.col, 0, 2, 'col'),
    proof: proofString(p.proof),
    publicInputs: fieldList(p.publicInputs, MOVE_PROOF_PUBLIC_INPUTS),
  };
}

/** Validate OPEN_CARDS' fields (the `kind` is checked by the caller). Throws on anything malformed. */
export function parseOpenCardsPayload(raw: Record<string, unknown>): OpenCardsPayload {
  if (!Array.isArray(raw.cards) || raw.cards.length !== OPEN_CARD_COUNT) {
    throw new Error(`OPEN_CARDS carries ${OPEN_CARD_COUNT} cards`);
  }
  return {
    cards: raw.cards.map((c, i) => intIn(c, 1, MAX_CARD_ID, `open card ${i}`)),
    proof: proofString(raw.proof),
    publicInputs: fieldList(raw.publicInputs, OPEN_CARDS_PUBLIC_INPUTS),
  };
}
