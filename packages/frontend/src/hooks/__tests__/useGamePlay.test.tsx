/**
 * The game, run by the clients (docs/plan/PRIVATE_GAMES.md section 6).
 *
 * Two useGamePlay instances play through a stand-in relay that only forwards
 * (MOVE by number, PEER as is). Proving and verification are stand-ins too —
 * the stand-in prover computes its public inputs with the same stand-in state
 * hash the receiver checks with, as the real ones do (the real pair is covered
 * by peerProofs.integration.test.ts). What is real: the rules, the hands with
 * their face-down cards, the order of things (open cards before the first
 * move, moves only once proven, nothing applied before it is checked), the
 * transcript in storage, and every refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGamePlay } from '../useGamePlay';
import { parsePeerPayload, type PeerPayload } from '../../aztec/peerChannel';
import {
  encodeBoardState,
  encodeOriginalOwners,
  expectedMoveInputs,
  expectedOpenCardsInputs,
  HIDDEN_CARD_ID,
  moveProofFromOutput,
  moveStateHashes,
  parseMovePayload,
  replay,
  type GameMove,
  type LocalGameFacts,
  type MovePayload,
  type StateHasher,
} from '../../aztec/localGame';
import { moverOf, normalizeField } from '../../aztec/privateGame';
import type { ProofChecks } from '../../aztec/moveChecks';
import type { PersistedGameState } from '../useGameStorage';
import type { Board, RoomState, ServerMessage } from '../../types';
import { P1_HAND, P2_HAND } from '../../aztec/__tests__/privateGameFixtures';

const ROOM = 'room-1';
const COMMITS = { commit1: normalizeField(0xc1), commit2: normalizeField(0xc2) };
const CELLS: [number, number][] = [[0, 0], [1, 1], [0, 1], [2, 2], [0, 2], [1, 0], [2, 0], [1, 2], [2, 1]];

const fakeHash: StateHasher = async (board, scores, turn, owners) => {
  let x = 0xcbf29ce484222325n;
  for (const v of [...board, ...scores.map(String), String(turn), ...owners.map(String)]) {
    for (const ch of v + '|') x = ((x ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & ((1n << 64n) - 1n);
  }
  return normalizeField(x);
};

const h = vi.hoisted(() => ({
  prove: vi.fn(),
  proveOpen: vi.fn(),
}));
// Through the real prover line, as the real hook does: the order things are
// proven in is part of what is tested.
vi.mock('../useProofGeneration', async () => {
  const { onProver } = await import('../../aztec/proverQueue');
  const api = {
    generateMoveProof: (...a: unknown[]) => onProver(() => h.prove(...a)),
    generateOpenCardsProof: (...a: unknown[]) => onProver(() => h.proveOpen(...a)),
    reset: () => {},
  };
  return { useProofGeneration: () => api };
});

/** The stand-in prover: what generateGameMoveProof publishes, with the stand-in hash. */
async function fakeProve(
  cardId: number, _row: number, _col: number, player: 1 | 2,
  before: Board, after: Board, sBefore: [number, number], sAfter: [number, number],
  c1: string, c2: string, ended: boolean, winnerId: number, hand: { cardIds: number[] },
) {
  const start = await fakeHash(encodeBoardState(before), sBefore, player, encodeOriginalOwners(before));
  const end = await fakeHash(encodeBoardState(after), sAfter, player === 1 ? 2 : 1, encodeOriginalOwners(after));
  const slot = hand.cardIds.indexOf(cardId);
  return moveProofFromOutput(btoa(`proof:${cardId}`), [c1, c2, start, end, ended ? 1 : 0, winnerId, cardId, slot].map(v => normalizeField(v)));
}

async function fakeProveOpen(hand: number[], _b: string, commit: string) {
  const cards = hand.slice(0, 3);
  return { cards, proof: btoa('open'), publicInputs: expectedOpenCardsInputs(commit, cards) };
}

function checks(over: Partial<ProofChecks> = {}): ProofChecks {
  return { hashState: fakeHash, verifyMove: vi.fn(async () => true), verifyOpenCards: vi.fn(async () => true), ...over };
}

/** What one side's stand-in relay delivers to the other. */
interface Inbound {
  deliver: (m: ServerMessage) => void;
  deliverPeer: (p: PeerPayload, room?: string) => void;
}

/** One player's world: its socket, channel and storage. `peer` is wired to the other player. */
function makeSide(role: 1 | 2) {
  const msgListeners = new Set<(m: ServerMessage) => void>();
  const peerListeners = new Set<(p: PeerPayload, room: string) => void>();
  const books: Record<string, Record<string, unknown>> = {};
  const relayed: Record<string, unknown>[] = [];
  let peer: Inbound | null = null;
  const later = (fn: () => void) => setTimeout(fn, 0);

  const side = {
    role,
    books,
    relayed,
    connect: (other: Inbound) => { peer = other; },
    deliver: (m: ServerMessage) => msgListeners.forEach(cb => cb(m)),
    deliverPeer: (p: PeerPayload, room = ROOM) => peerListeners.forEach(cb => cb(p, room)),
    storage: {
      readGame: vi.fn((id: string) => (books[id] ? JSON.parse(JSON.stringify(books[id])) : null)),
      mergeGame: vi.fn((id: string, fields: Partial<PersistedGameState>) => {
        const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        books[id] = { ...(books[id] ?? { gameId: id, savedAt: 0 }), ...JSON.parse(JSON.stringify(defined)) };
      }),
    },
    ws: {
      connected: true,
      roomState: null as RoomState | null,
      addMessageListener: (cb: (m: ServerMessage) => void) => { msgListeners.add(cb); return () => { msgListeners.delete(cb); }; },
      sendMove: vi.fn((gameId: string, moveNumber: number, sealed: { iv: string; ciphertext: string }) => {
        const m = { type: 'MOVE' as const, gameId, moveNumber, iv: sealed.iv, ciphertext: sealed.ciphertext };
        relayed.push(m);
        if (peer) { const p = peer; later(() => p.deliver(m)); }
      }),
    },
    channel: {
      sealMove: vi.fn(async (_room: string, move: MovePayload) => ({ iv: 'iv', ciphertext: btoa(JSON.stringify(move)) })),
      openMove: vi.fn(async (_room: string, sealed: { ciphertext: string }) => parseMovePayload(JSON.parse(atob(sealed.ciphertext)))),
      sendPeer: vi.fn(async (payload: PeerPayload) => {
        relayed.push({ type: 'PEER', kind: payload.kind });
        const opened = parsePeerPayload(JSON.parse(JSON.stringify(payload)));
        if (peer) { const p = peer; later(() => p.deliverPeer(opened)); }
      }),
      addPeerListener: (cb: (p: PeerPayload, room: string) => void) => { peerListeners.add(cb); return () => { peerListeners.delete(cb); }; },
    },
  };
  return side;
}

type Side = ReturnType<typeof makeSide>;

function mount(side: Side, opts: { checks?: ProofChecks; ready?: boolean; hand?: number[] } = {}) {
  const hand = opts.hand ?? (side.role === 1 ? P1_HAND : P2_HAND);
  const c = opts.checks ?? checks();
  const ready = opts.ready ?? false;
  type Props = { commits: (typeof COMMITS & { roomId?: string | null }) | null; blinding: string | null; ws: Side['ws'] };
  return renderHook<ReturnType<typeof useGamePlay>, Props>(
    (p: Props) => useGamePlay({
      ws: p.ws, cardIds: hand, blindingFactor: p.blinding, commits: p.commits,
      channel: side.channel, storage: side.storage, checks: c,
    }),
    { initialProps: { commits: ready ? COMMITS : null, blinding: ready ? '0xb' : null, ws: side.ws } },
  );
}

/** Let timers, promises and effects run until things stop moving. */
const flush = () => act(async () => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); });

const matchFound = (side: Side) => act(() => { side.deliver({ type: 'MATCH_FOUND', gameId: ROOM, playerNumber: side.role }); });

/** The MOVE an honest opponent would send for `move`, given the facts before it (stand-in hash). */
async function honestMove(facts: LocalGameFacts, move: GameMove): Promise<ServerMessage> {
  const before = replay(facts).state;
  const after = replay({ ...facts, moves: [...facts.moves, move] }).state;
  const hashes = await moveStateHashes(before, after, moverOf(move.moveNumber), fakeHash);
  const body: MovePayload = {
    cardId: move.cardId, slot: move.slot, row: move.row, col: move.col,
    proof: btoa(`proof:${move.cardId}`), publicInputs: expectedMoveInputs({ ...COMMITS, hashes, after, move }),
  };
  return { type: 'MOVE', gameId: ROOM, moveNumber: move.moveNumber, iv: 'iv', ciphertext: btoa(JSON.stringify(body)) };
}

const p1Move = (n: number, slot = n / 2): GameMove => ({ moveNumber: n, cardId: P1_HAND[slot], slot, row: CELLS[n][0], col: CELLS[n][1] });
const p2Move = (n: number, slot: number): GameMove => ({ moveNumber: n, cardId: P2_HAND[slot], slot, row: CELLS[n][0], col: CELLS[n][1] });
const asP2Facts = (moves: GameMove[]): LocalGameFacts => ({ role: 2, ownHand: P2_HAND, opponentOpen: null, moves });

beforeEach(() => {
  vi.clearAllMocks();
  h.prove.mockImplementation(fakeProve);
  h.proveOpen.mockImplementation(fakeProveOpen);
});

describe('two clients play a whole game through a relay that only forwards', () => {
  it('both end on the same board, scores and result, each with the full transcript', async () => {
    const a = makeSide(1);
    const b = makeSide(2);
    a.connect(b);
    b.connect(a);
    const p1 = mount(a);
    const p2 = mount(b);
    await matchFound(a);
    await matchFound(b);

    // Before anything is proven: our own hand, five face-down cards opposite.
    expect(p1.result.current.gameState!.player1Hand.map(c => c.id)).toEqual(P1_HAND);
    expect(p1.result.current.gameState!.player2Hand.map(c => c.id)).toEqual(Array(5).fill(HIDDEN_CARD_ID));
    expect(p1.result.current.myHandHidden).toEqual([false, false, false, true, true]);

    // Player 1 moves before the commitments are known: on its board at once,
    // owed, and nothing sent.
    await act(async () => { void p1.result.current.handlePlaceCard(0, ...CELLS[0]); });
    expect(p1.result.current.gameState!.board[0][0].card?.id).toBe(P1_HAND[0]);
    expect(p1.result.current.owedMoveProofs).toBe(1);
    expect(a.relayed).toEqual([]);

    // Both records known: open cards go out first, then the queued move.
    p1.rerender({ commits: COMMITS, blinding: '0xb1', ws: a.ws });
    p2.rerender({ commits: COMMITS, blinding: '0xb2', ws: b.ws });
    await flush();
    expect(a.relayed.map(m => m.type === 'PEER' ? `PEER ${m.kind}` : `MOVE ${m.moveNumber}`)).toEqual(['PEER OPEN_CARDS', 'MOVE 0']);
    expect(h.proveOpen.mock.calls[0]).toEqual([P1_HAND, '0xb1', COMMITS.commit1]);
    expect(p1.result.current.owedMoveProofs).toBe(0);
    // Player 2 sees player 1's open cards, its move, and two face-down cards.
    expect(p2.result.current.gameState!.player1Hand.map(c => c.id)).toEqual([P1_HAND[1], P1_HAND[2], HIDDEN_CARD_ID, HIDDEN_CARD_ID]);
    expect(p2.result.current.gameState!.board[0][0].card?.id).toBe(P1_HAND[0]);
    expect(p2.result.current.opponentOpenKnown).toBe(true);
    expect(p1.result.current.opponentOpenKnown).toBe(true);

    // The rest of the game: each side plays its first card in hand.
    for (let n = 1; n < 9; n++) {
      const mover = n % 2 === 0 ? p1 : p2;
      expect(mover.result.current.gameState!.currentTurn).toBe(n % 2 === 0 ? 'player1' : 'player2');
      await act(async () => { void mover.result.current.handlePlaceCard(0, ...CELLS[n]); });
      await flush();
      expect(p1.result.current.collectedMoveProofs).toHaveLength(n + 1);
      expect(p2.result.current.collectedMoveProofs).toHaveLength(n + 1);
    }

    const s1 = p1.result.current.gameState!;
    const s2 = p2.result.current.gameState!;
    expect(encodeBoardState(s1.board)).toEqual(encodeBoardState(s2.board));
    expect(encodeOriginalOwners(s1.board)).toEqual(encodeOriginalOwners(s2.board));
    expect([s1.player1Score, s1.player2Score]).toEqual([s2.player1Score, s2.player2Score]);
    expect(s1.status).toBe('finished');
    expect(p1.result.current.gameOver).toEqual(p2.result.current.gameOver);
    expect(p1.result.current.gameOver).not.toBeNull();
    // Player 2 holds its last card; player 1 sees it face down (slot 4 is hidden).
    expect(s2.player2Hand.map(c => c.id)).toEqual([P2_HAND[4]]);
    expect(s1.player2Hand.map(c => c.id)).toEqual([HIDDEN_CARD_ID]);

    // Both transcripts: the same nine proofs, in order, written to storage.
    expect(p1.result.current.getMoveProofs()).toEqual(p2.result.current.getMoveProofs());
    expect((a.books[ROOM].moves as unknown[])).toHaveLength(9);
    expect((b.books[ROOM].moves as unknown[])).toHaveLength(9);
    expect(p1.result.current.canSettle).toBe(true);
    expect(p2.result.current.canSettle).toBe(true);

    // The relay saw move numbers and sealed bodies — nothing else of the game.
    for (const m of [...a.relayed, ...b.relayed]) {
      expect(Object.keys(m).sort()).toEqual(m.type === 'MOVE' ? ['ciphertext', 'gameId', 'iv', 'moveNumber', 'type'] : ['kind', 'type']);
    }
    expect(b.relayed.filter(m => m.type === 'MOVE').map(m => m.moveNumber)).toEqual([1, 3, 5, 7]);
  });
});

describe('the opponent\'s moves', () => {
  /** Player 2, ready, matched, with player 1's open cards unknown. */
  async function asPlayer2(c = checks()) {
    const side = makeSide(2);
    const hook = mount(side, { checks: c, ready: true });
    await matchFound(side);
    await flush();
    return { side, hook, c };
  }

  it('is applied only once checked, and written to the transcript with its proof', async () => {
    const { side, hook, c } = await asPlayer2();
    await act(async () => { side.deliver(await honestMove(asP2Facts([]), p1Move(0))); });
    await flush();
    expect(c.verifyMove).toHaveBeenCalledTimes(1);
    expect(hook.result.current.gameState!.board[0][0].card?.id).toBe(P1_HAND[0]);
    expect(hook.result.current.gameState!.currentTurn).toBe('player2');
    const stored = side.books[ROOM] as { moves: { proof: { placedCardId: number } }[]; inbox: unknown[] };
    expect(stored.moves.map(m => m.proof.placedCardId)).toEqual([P1_HAND[0]]);
    expect(stored.inbox).toEqual([]);
  });

  it('a move that fails a check is refused: the board does not change, the game halts, and a reload still says so', async () => {
    const { side, hook } = await asPlayer2();
    const msg = await honestMove(asP2Facts([]), p1Move(0)) as Extract<ServerMessage, { type: 'MOVE' }>;
    const body = JSON.parse(atob(msg.ciphertext));
    body.publicInputs[2] = normalizeField(123); // a start state that is not this board
    await act(async () => { side.deliver({ ...msg, ciphertext: btoa(JSON.stringify(body)) }); });
    await flush();
    expect(hook.result.current.protocolError).toMatch(/move 0 was rejected: its proof's start_state_hash does not match/);
    expect(hook.result.current.gameState!.board[0][0].card).toBeNull();
    expect(side.books[ROOM].protocolError).toMatch(/start_state_hash/);
    // Our own move cannot be made on a halted game.
    await act(async () => { await hook.result.current.handlePlaceCard(0, 2, 2); });
    expect(hook.result.current.owedMoveProofs).toBe(0);
  });

  it('a proof that does not verify is refused', async () => {
    const { side, hook } = await asPlayer2(checks({ verifyMove: vi.fn(async () => false) }));
    await act(async () => { side.deliver(await honestMove(asP2Facts([]), p1Move(0))); });
    await flush();
    expect(hook.result.current.protocolError).toMatch(/its proof does not verify/);
  });

  it('a body that does not open halts the game', async () => {
    const { side, hook } = await asPlayer2();
    side.channel.openMove.mockRejectedValueOnce(new Error('OperationError'));
    await act(async () => { side.deliver(await honestMove(asP2Facts([]), p1Move(0))); });
    await flush();
    expect(hook.result.current.protocolError).toMatch(/does not open/);
  });

  it('a verifier that fails says nothing about the move: it is kept and checked again', async () => {
    const verifyMove = vi.fn().mockRejectedValueOnce(new Error('wasm trap')).mockResolvedValue(true);
    const { side, hook } = await asPlayer2(checks({ verifyMove }));
    await act(async () => { side.deliver(await honestMove(asP2Facts([]), p1Move(0))); });
    await flush();
    expect(hook.result.current.protocolError).toBeNull();
    expect(hook.result.current.playError).toMatch(/wasm trap/);
    expect((side.books[ROOM].inbox as unknown[])).toHaveLength(1);
    // Back online (or a reload): checked again, and applied.
    side.ws.connected = false;
    hook.rerender({ commits: COMMITS, blinding: '0xb', ws: { ...side.ws } });
    side.ws.connected = true;
    hook.rerender({ commits: COMMITS, blinding: '0xb', ws: { ...side.ws } });
    await flush();
    expect(hook.result.current.gameState!.board[0][0].card?.id).toBe(P1_HAND[0]);
    expect(hook.result.current.playError).toBeNull();
  });

  it('a replayed copy is applied once; a different move under the same number halts the game', async () => {
    const { side, hook, c } = await asPlayer2();
    const m0 = await honestMove(asP2Facts([]), p1Move(0));
    await act(async () => { side.deliver(m0); });
    await flush();
    await act(async () => { side.deliver(m0); });
    await flush();
    expect(c.verifyMove).toHaveBeenCalledTimes(1);
    expect(hook.result.current.protocolError).toBeNull();

    const other = await honestMove(asP2Facts([]), { ...p1Move(0), row: 2, col: 2 });
    await act(async () => { side.deliver(other); });
    await flush();
    expect(hook.result.current.protocolError).toMatch(/two different moves numbered 0/);
  });

  it('a move that runs ahead waits for the one before it', async () => {
    const { side, hook } = await asPlayer2();
    await act(async () => { side.deliver(await honestMove(asP2Facts([]), p1Move(0))); });
    await flush();
    // Move 2 arrives before our own move 1 exists: held, not refused.
    const m2 = await honestMove(asP2Facts([p1Move(0), p2Move(1, 0)]), p1Move(2));
    await act(async () => { side.deliver(m2); });
    await flush();
    expect(hook.result.current.collectedMoveProofs).toHaveLength(1);
    expect(hook.result.current.protocolError).toBeNull();
    // Our move 1 lands, and the held move follows it.
    await act(async () => { void hook.result.current.handlePlaceCard(0, ...CELLS[1]); });
    await flush();
    expect(hook.result.current.collectedMoveProofs).toHaveLength(3);
    expect(hook.result.current.gameState!.board[0][1].card?.id).toBe(P1_HAND[1]);
  });

  it('a MOVE that arrives while a stale copy is being opened is not lost', async () => {
    const { side, hook } = await asPlayer2();
    const m0 = await honestMove(asP2Facts([]), p1Move(0)) as Extract<ServerMessage, { type: 'MOVE' }>;
    await act(async () => { side.deliver(m0); });
    await flush();
    await act(async () => { void hook.result.current.handlePlaceCard(0, ...CELLS[1]); });
    await flush();
    // The relay replays move 0 (re-sealed); opening it takes a while...
    let release!: () => void;
    const opened = side.channel.openMove.getMockImplementation()!;
    side.channel.openMove.mockImplementationOnce(async (room, sealed) => {
      await new Promise<void>(r => { release = r; });
      return opened(room, sealed);
    });
    const copy = { ...m0, ciphertext: btoa(atob(m0.ciphertext) + ' ') };
    await act(async () => { side.deliver(copy); });
    await flush();
    // ...and move 2 lands meanwhile.
    const m2 = await honestMove(asP2Facts([p1Move(0), p2Move(1, 0)]), p1Move(2));
    await act(async () => { side.deliver(m2); });
    await act(async () => { release(); });
    await flush();
    expect(hook.result.current.protocolError).toBeNull();
    expect(hook.result.current.collectedMoveProofs).toHaveLength(3);
    expect(side.books[ROOM].inbox).toEqual([]);
  });

  it('nothing is proven or checked against another room\'s commitments', async () => {
    const side = makeSide(2);
    const c = checks();
    const hook = mount(side, { checks: c });
    await matchFound(side);
    // The session still holds the last game's commitments (a settlement running on).
    const stale = { ...COMMITS, roomId: 'room-before' };
    hook.rerender({ commits: stale, blinding: '0xb', ws: side.ws });
    await act(async () => { side.deliver(await honestMove(asP2Facts([]), p1Move(0))); });
    await flush();
    expect(c.verifyMove).not.toHaveBeenCalled();
    expect(h.proveOpen).not.toHaveBeenCalled();
    expect(hook.result.current.protocolError).toBeNull();
    expect(hook.result.current.canSettle).toBe(false);
    // This room's arrive: the held move is checked, our open cards proven.
    hook.rerender({ commits: { ...COMMITS, roomId: ROOM }, blinding: '0xb', ws: side.ws });
    await flush();
    expect(c.verifyMove).toHaveBeenCalledTimes(1);
    expect(h.proveOpen).toHaveBeenCalledTimes(1);
    expect(hook.result.current.collectedMoveProofs).toHaveLength(1);
  });

  it('a MOVE for a game this client is not running is kept for it, not applied anywhere', async () => {
    const { side, hook } = await asPlayer2();
    side.books['room-old'] = { gameId: 'room-old', savedAt: 0, playerNumber: 2, selectedCardIds: P2_HAND };
    const m = await honestMove(asP2Facts([]), p1Move(0));
    await act(async () => { side.deliver({ ...m, gameId: 'room-old' } as ServerMessage); });
    await flush();
    expect((side.books['room-old'].inbox as unknown[])).toHaveLength(1);
    expect(hook.result.current.gameState!.board[0][0].card).toBeNull();
    // ...and one for a room it has never heard of is ignored.
    await act(async () => { side.deliver({ ...m, gameId: 'room-unknown' } as ServerMessage); });
    expect(side.books['room-unknown']).toBeUndefined();
  });
});

describe('the opponent\'s open cards', () => {
  it('are shown once their proof checks out against the opponent\'s record', async () => {
    const side = makeSide(1);
    const c = checks();
    const hook = mount(side, { checks: c, ready: true });
    await matchFound(side);
    await flush();
    await act(async () => {
      side.deliverPeer({ kind: 'OPEN_CARDS', cards: P2_HAND.slice(0, 3), proof: btoa('open'), publicInputs: expectedOpenCardsInputs(COMMITS.commit2, P2_HAND.slice(0, 3)) });
    });
    await flush();
    expect(hook.result.current.gameState!.player2Hand.map(x => x.id)).toEqual([...P2_HAND.slice(0, 3), HIDDEN_CARD_ID, HIDDEN_CARD_ID]);
    expect(side.books[ROOM].opponentOpenCards).toEqual(P2_HAND.slice(0, 3));
  });

  it('are refused when proven against another commitment, or when a different set follows', async () => {
    const side = makeSide(1);
    const hook = mount(side, { ready: true });
    await matchFound(side);
    await flush();
    await act(async () => {
      side.deliverPeer({ kind: 'OPEN_CARDS', cards: P2_HAND.slice(0, 3), proof: btoa('open'), publicInputs: expectedOpenCardsInputs(COMMITS.commit1, P2_HAND.slice(0, 3)) });
    });
    await flush();
    expect(hook.result.current.protocolError).toMatch(/open cards were rejected: the open-cards proof's card_commit_hash does not match/);
    expect(hook.result.current.gameState!.player2Hand.map(x => x.id)).toEqual(Array(5).fill(HIDDEN_CARD_ID));

    const other = makeSide(1);
    const second = mount(other, { ready: true });
    await matchFound(other);
    await flush();
    const open = (cards: number[]) => ({ kind: 'OPEN_CARDS' as const, cards, proof: btoa('open'), publicInputs: expectedOpenCardsInputs(COMMITS.commit2, cards) });
    await act(async () => { other.deliverPeer(open(P2_HAND.slice(0, 3))); });
    await flush();
    await act(async () => { other.deliverPeer(open(P2_HAND.slice(0, 3))); }); // a repeat: fine
    await flush();
    expect(second.result.current.protocolError).toBeNull();
    await act(async () => { other.deliverPeer(open([P2_HAND[0], P2_HAND[1], P2_HAND[4]])); });
    await flush();
    expect(second.result.current.protocolError).toMatch(/second, different set of open cards/);
  });
});

describe('getting ready', () => {
  it('computes the verification keys on the prover line as soon as a game starts', async () => {
    const side = makeSide(1);
    const prepare = vi.fn(async () => {});
    mount(side, { checks: checks({ prepare }) });
    await matchFound(side);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe('our own moves', () => {
  it('owe the opponent a proof until it is sent; a proof that fails takes the move back', async () => {
    const side = makeSide(1);
    const hook = mount(side, { ready: true });
    await matchFound(side);
    await flush();
    let release!: (v: unknown) => void;
    h.prove.mockImplementationOnce(() => new Promise((_res, rej) => { release = rej; }));
    await act(async () => { void hook.result.current.handlePlaceCard(1, 0, 0); });
    await flush();
    expect(hook.result.current.owedMoveProofs).toBe(1);
    expect(hook.result.current.moveProofStatus).toBe('generating');
    expect(hook.result.current.gameState!.board[0][0].card?.id).toBe(P1_HAND[1]);

    await act(async () => { release(new Error('circuit says no')); });
    await flush();
    expect(hook.result.current.owedMoveProofs).toBe(0);
    expect(hook.result.current.gameState!.board[0][0].card).toBeNull();
    expect(hook.result.current.playError).toMatch(/circuit says no/);
    expect(side.ws.sendMove).not.toHaveBeenCalled();

    // Played again, it goes out with the slot it was committed in.
    await act(async () => { void hook.result.current.handlePlaceCard(1, 0, 0); });
    await flush();
    expect(side.ws.sendMove).toHaveBeenCalledTimes(1);
    const body = JSON.parse(atob(side.ws.sendMove.mock.calls[0][2].ciphertext));
    expect(body).toMatchObject({ cardId: P1_HAND[1], slot: 1, row: 0, col: 0 });
    expect(Object.keys(body).sort()).toEqual(['cardId', 'col', 'proof', 'publicInputs', 'row', 'slot']);
  });

  it('are written to the transcript before they are sent', async () => {
    const side = makeSide(1);
    const hook = mount(side, { ready: true });
    await matchFound(side);
    await flush();
    side.ws.sendMove.mockImplementationOnce(() => {
      expect((side.books[ROOM].moves as unknown[])).toHaveLength(1);
    });
    await act(async () => { void hook.result.current.handlePlaceCard(0, 0, 0); });
    await flush();
    expect(side.ws.sendMove).toHaveBeenCalledTimes(1);
  });
});

describe('coming back (section 6.4)', () => {
  /** What player 2's storage holds after move 2: three checked moves. */
  async function storedAfterThreeMoves(): Promise<PersistedGameState> {
    const moves = [p1Move(0), p2Move(1, 3), p1Move(2)];
    const links = [];
    for (let i = 0; i < moves.length; i++) {
      const facts = asP2Facts(moves.slice(0, i));
      const msg = await honestMove(facts, moves[i]) as Extract<ServerMessage, { type: 'MOVE' }>;
      const body = JSON.parse(atob(msg.ciphertext));
      links.push({ ...moves[i], proof: moveProofFromOutput(body.proof, body.publicInputs) });
    }
    return {
      gameId: ROOM, playerNumber: 2, selectedCardIds: P2_HAND, savedAt: Date.now(),
      moves: links, opponentOpenCards: P1_HAND.slice(0, 3),
    };
  }

  it('rebuilds the board from the stored transcript, then checks what the relay replayed', async () => {
    const side = makeSide(2);
    const saved = await storedAfterThreeMoves();
    side.books[ROOM] = JSON.parse(JSON.stringify(saved));
    const hook = mount(side, { ready: true });
    await act(async () => { hook.result.current.restoreFromSave(saved); });
    await flush();
    const s = hook.result.current.gameState!;
    expect(hook.result.current.collectedMoveProofs).toHaveLength(3);
    expect(s.currentTurn).toBe('player2');
    expect(s.board[0][0].card?.id).toBe(P1_HAND[0]);
    expect(s.board[1][1].card?.id).toBe(P2_HAND[3]);
    expect(s.player1Hand.map(c => c.id)).toEqual([P1_HAND[2], HIDDEN_CARD_ID, HIDDEN_CARD_ID]);
    expect(hook.result.current.lastCaptures).toEqual([]);
  });

  it('applies a move the relay replayed while this client was on the menu', async () => {
    const side = makeSide(2);
    const saved = await storedAfterThreeMoves();
    const two = { ...saved, moves: saved.moves!.slice(0, 2) };
    side.books[ROOM] = JSON.parse(JSON.stringify(two));
    // Delivered (by the relay's replay) before the game was resumed: kept.
    const hook = mount(side, { ready: true });
    const m2 = await honestMove(asP2Facts([p1Move(0), p2Move(1, 3)]), p1Move(2));
    await act(async () => { side.deliver(m2); });
    expect((side.books[ROOM].inbox as unknown[])).toHaveLength(1);
    await act(async () => { hook.result.current.restoreFromSave(two as PersistedGameState); });
    await flush();
    expect(hook.result.current.collectedMoveProofs).toHaveLength(3);
    expect(hook.result.current.gameState!.board[0][1].card?.id).toBe(P1_HAND[1]);
  });

  it('sends again our moves the relay says it never got (ROOM_STATE)', async () => {
    const side = makeSide(1);
    // Player 1's transcript: moves 0-2, of which the relay holds 0-1.
    const moves = [p1Move(0), p2Move(1, 3), p1Move(2)];
    const links = [];
    for (let i = 0; i < 3; i++) {
      const facts: LocalGameFacts = { role: 1, ownHand: P1_HAND, opponentOpen: null, moves: moves.slice(0, i) };
      const msg = await honestMove(facts, moves[i]) as Extract<ServerMessage, { type: 'MOVE' }>;
      const body = JSON.parse(atob(msg.ciphertext));
      links.push({ ...moves[i], proof: moveProofFromOutput(body.proof, body.publicInputs) });
    }
    const saved: PersistedGameState = { gameId: ROOM, playerNumber: 1, selectedCardIds: P1_HAND, savedAt: Date.now(), moves: links };
    side.books[ROOM] = JSON.parse(JSON.stringify(saved));
    const hook = mount(side, { ready: true });
    await act(async () => { hook.result.current.restoreFromSave(saved); });
    await flush();
    const roomState: RoomState = { gameId: ROOM, playerNumber: 1, movesMade: 2, opponentConnected: true };
    hook.rerender({ commits: COMMITS, blinding: '0xb', ws: { ...side.ws, roomState } });
    await flush();
    expect(side.ws.sendMove.mock.calls.map(c => c[1])).toEqual([2]);
    // The same ROOM_STATE again (a re-render) sends nothing more.
    hook.rerender({ commits: COMMITS, blinding: '0xb', ws: { ...side.ws, roomState } });
    await flush();
    expect(side.ws.sendMove).toHaveBeenCalledTimes(1);
  });

  it('a stored transcript that does not replay is reported, not played on', async () => {
    const side = makeSide(2);
    const saved = await storedAfterThreeMoves();
    const broken = { ...saved, moves: [saved.moves![0], { ...saved.moves![1], row: 0, col: 0 }] };
    const hook = mount(side, { ready: true });
    await act(async () => { hook.result.current.restoreFromSave(broken as PersistedGameState); });
    expect(hook.result.current.protocolError).toMatch(/does not replay/);
    // The part that does replay is still shown, with the error.
    expect(hook.result.current.collectedMoveProofs).toHaveLength(1);
    expect(hook.result.current.gameState!.board[0][0].card?.id).toBe(P1_HAND[0]);
  });
});
