/**
 * Playing a scripted game through two real browsers, and checking that the
 * two clients agree — with each other, with the rules mirror, and with the
 * records the chain holds.
 *
 * Since Phase B each client runs the game itself (docs/plan/PRIVATE_GAMES.md
 * §6): nobody else holds a board. So after every move both clients' own
 * games are compared with the mirror — board, turn, status, scores, hands —
 * and at the end their transcripts with each other: the same nine moves, the
 * same proofs, bound to the hand commitments in the on-chain records.
 */
import { expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import type { PhaseSnapshot } from '../../frontend/src/testkit/contract.js';
import type { PlayerDriver, StoredGameSnapshot } from './player.js';
import { OPEN_SLOTS, otherPlayer, type ExpectedGame } from './expected.js';
import { canonicalField } from './chain.js';

/** Which browser plays which side. */
export type SeatOf = (player: Player) => PlayerDriver;

/** The record's `hand_commit` (docs/plan/PRIVATE_GAMES.md §3.3: `[seat, hand_commit, ...]`). */
const HAND_COMMIT = 1;

function cells(p: PhaseSnapshot) {
  return p.game!.board.map(r => r.map(c => ({ cardId: c.cardId, owner: c.owner, originalOwner: c.originalOwner })));
}

/**
 * One client's own game against the mirror: board, status, turn, scores and
 * its own hand. The opponent's hand shows nothing it may not: a hidden slot
 * (3, 4) stays face down (0) until it is played, and an open slot shows its
 * own card or — until OPEN_CARDS checks out — nothing.
 */
export function expectViewMatches(mirror: ExpectedGame, me: Player, phase: PhaseSnapshot, label: string): void {
  const g = phase.game;
  expect(g, `${label}: no game on screen`).not.toBeNull();
  expect(g!.protocolError, `${label}: refused the opponent's payload`).toBeNull();
  expect(cells(phase), `${label}: board`).toEqual(mirror.board);
  expect({ status: g!.status, turn: g!.currentTurn }, `${label}: status and turn`)
    .toEqual({ status: mirror.state.status, turn: mirror.state.currentTurn });
  expect({ mine: g!.myScore, theirs: g!.opponentScore }, `${label}: scores`).toEqual(mirror.scoresFor(me));
  expect(g!.myHandCardIds, `${label}: own hand`).toEqual(mirror.handOf(me));

  const them = otherPlayer(me);
  const slots = mirror.unplayedSlots(them);
  expect(g!.opponentHandCardIds.length, `${label}: the opponent's hand size`).toBe(slots.length);
  slots.forEach((slot, i) => {
    const shown = g!.opponentHandCardIds[i];
    if (slot >= OPEN_SLOTS) {
      expect(shown, `${label}: the opponent's hidden slot ${slot} is face up before it was played`).toBe(0);
    } else {
      expect([0, mirror.hands[them][slot]], `${label}: the opponent's open slot ${slot} shows a wrong card`)
        .toContain(shown);
    }
  });
}

/**
 * Play the mirror's scripted moves (hand slot 0 into the first empty cell)
 * with real canvas clicks until `upTo` moves are on the board. After each, the
 * mover's board shows the move at once and the opponent's once it has been
 * proven, sent, opened and checked; then both views must match the mirror.
 */
export async function playMoves(mirror: ExpectedGame, seatOf: SeatOf, upTo: number, label = ''): Promise<void> {
  while (mirror.moves.length < upTo) {
    const moveNumber = mirror.moves.length;
    const player = mirror.state.currentTurn;
    const mover = seatOf(player);
    const waiter = seatOf(otherPlayer(player));
    const { handIndex, row, col } = mirror.nextMove();

    await mover.waitReadyToMove();
    await mover.selectHandCard(handIndex);
    await mover.clickCell(row, col);
    mirror.apply(player, handIndex, row, col);

    const [moverView, waiterView] = await Promise.all([
      mover.waitBoardCount(mirror.occupiedCount),
      waiter.waitOpponentMove(mirror.occupiedCount),
    ]);
    const what = `${label}move ${moveNumber} (${player} → [${row},${col}])`;
    expectViewMatches(mirror, player, moverView, `${what}, ${mover.name}'s game`);
    expectViewMatches(mirror, otherPlayer(player), waiterView, `${what}, ${waiter.name}'s game`);
  }
}

/** Both clients call the game over with the mirror's result, and still agree on every cell and score. */
export async function expectGameOver(
  mirror: ExpectedGame, seatOf: SeatOf, label = '',
): Promise<Record<Player, PhaseSnapshot>> {
  expect(mirror.state.status, `${label}the mirror's game is over`).toBe('finished');
  const [p1, p2] = await Promise.all([seatOf('player1').waitGameOver(), seatOf('player2').waitGameOver()]);
  const views: Record<Player, PhaseSnapshot> = { player1: p1, player2: p2 };
  for (const me of ['player1', 'player2'] as const) {
    const who = `${label}${seatOf(me).name} (${me})`;
    expect(views[me].ws.gameOver!.winner, `${who}: result`).toBe(mirror.state.winner);
    expectViewMatches(mirror, me, views[me], `${who} at game over`);
  }
  return views;
}

/**
 * Both stored transcripts are the mirror's game: the same moves (card, slot,
 * cell) and the same proofs, whose public inputs say what the game was —
 * bound to the two records' hand commitments, chained from move to move,
 * naming each card and slot, and ending only at the last move, with the
 * mirror's result. Nothing is left unchecked in the inbox or refused, and
 * each side holds its own open cards and the opponent's, as proven.
 */
export function expectTranscriptsAgree(
  mirror: ExpectedGame, stored: Record<Player, StoredGameSnapshot>, label = '',
): void {
  const want = mirror.moves.map(({ moveNumber, cardId, slot, row, col }) => ({ moveNumber, cardId, slot, row, col }));
  const ref = stored.player1;
  expect(ref.record1 && ref.record2, `${label}both records are stored`).toBeTruthy();
  const commits = [canonicalField(ref.record1![HAND_COMMIT]), canonicalField(ref.record2![HAND_COMMIT])];

  for (const me of ['player1', 'player2'] as const) {
    const s = stored[me];
    const who = `${label}${me}'s stored game`;
    expect(s.protocolError, `${who}: refused a payload`).toBeNull();
    expect(s.inbox, `${who}: moves delivered but never checked`).toEqual([]);
    expect(s.moves.map(({ moveNumber, cardId, slot, row, col }) => ({ moveNumber, cardId, slot, row, col })),
      `${who}: transcript`).toEqual(want);
    expect(s.ownOpenCards, `${who}: own open cards`).toEqual(mirror.hands[me].slice(0, OPEN_SLOTS));
    expect(s.opponentOpenCards, `${who}: the opponent's proven open cards`)
      .toEqual(mirror.hands[otherPlayer(me)].slice(0, OPEN_SLOTS));
  }

  const inputs = (s: StoredGameSnapshot) => s.moves.map(m => m.publicInputs.map(canonicalField));
  expect(inputs(stored.player2), `${label}both players hold the same proofs`).toEqual(inputs(ref));

  const finished = mirror.state.status === 'finished';
  inputs(ref).forEach((pi, i) => {
    const at = `${label}move ${i}'s proof`;
    expect(pi.length, `${at}: public inputs`).toBe(8);
    const [c1, c2, start, end, ended, winner, card, slot] = pi;
    expect([c1, c2], `${at}: hand commitments are not the records'`).toEqual(commits);
    if (i > 0) expect(start, `${at}: does not start where move ${i - 1} ended`).toBe(inputs(ref)[i - 1][3]);
    expect(end, `${at}: ends where it starts`).not.toBe(start);
    expect([BigInt(card), BigInt(slot)], `${at}: placed card and slot`).toEqual([BigInt(want[i].cardId), BigInt(want[i].slot)]);
    const last = finished && i === want.length - 1;
    expect([BigInt(ended), BigInt(winner)], `${at}: game_ended / winner_id`)
      .toEqual(last ? [1n, BigInt(mirror.winnerId)] : [0n, 0n]);
  });
}

/** Both players' stored games for `wsGameId`, by side. */
export async function storedGames(seatOf: SeatOf, wsGameId: string): Promise<Record<Player, StoredGameSnapshot>> {
  const [p1, p2] = await Promise.all([seatOf('player1').storedGame(wsGameId), seatOf('player2').storedGame(wsGameId)]);
  expect(p1, `${seatOf('player1').name} has no stored game ${wsGameId}`).not.toBeNull();
  expect(p2, `${seatOf('player2').name} has no stored game ${wsGameId}`).not.toBeNull();
  return { player1: p1!, player2: p2! };
}
