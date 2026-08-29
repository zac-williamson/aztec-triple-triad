import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import { ArenaBot, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import { createGame, getCardsByIds, placeCard } from '@axolotl-arena/game-logic';
import type { GameState } from '@axolotl-arena/game-logic';

/** Minimal stand-in for the `ws` client: records what the bot sends. */
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  /** Deliver a server frame to the bot. */
  deliver(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  lastOfType(type: string) { return [...this.sent].reverse().find(m => m.type === type); }
  countOfType(type: string) { return this.sent.filter(m => m.type === type).length; }
}

const CARDS = [1, 2, 3, 4, 5];

function makeConfig(over: Partial<ArenaBotConfig> = {}): ArenaBotConfig {
  return {
    wsUrl: 'ws://test', httpUrl: 'http://test', token: 'tok',
    joinThresholdMs: 20_000, pollIntervalMs: 1_000, queueTimeoutMs: 60_000,
    handCardIds: CARDS, difficulty: 'greedy', moveDelayMs: 0,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
    // Unit tests assert the IMMEDIATE verdict on an incomplete transcript.
    settleWaitMs: 0,
    sweepIntervalMs: 900_000,
    gameTimeoutMs: 1_800_000,
    healthPort: 0,
    ...over,
  };
}

function freshState(): GameState {
  return createGame(getCardsByIds(CARDS), getCardsByIds(CARDS));
}

/**
 * A state where it is PLAYER 2's turn — the bot only ever joins, so it is always
 * player 2 and never moves on a fresh board.
 */
function botTurnState(): GameState {
  return placeCard(freshState(), 'player1', 0, 0, 0).newState;
}

/**
 * The join handshake the bot needs before it will commit (and therefore before
 * it will play): the creator shares its on-chain id, then its create_game is
 * confirmed. As a joiner the bot has no other route to `committed`.
 */
function deliverJoinHandshake(socket: FakeSocket, gameId = 'g1', onChainGameId = FIELD(0xc1)): void {
  socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId, aztecAddress: FIELD(0xdef), onChainGameId, gameRandomness: SIX_RANDOM });
  socket.deliver({ type: 'ON_CHAIN_STATUS', gameId, status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
}

/** Build a bot wired to a fake socket and a settable queue snapshot. */
function harness(cfg = makeConfig()) {
  const socket = new FakeSocket();
  let queue: QueueSnapshot = { length: 0, oldestWaitMs: 0, entries: [] };
  let clock = 1_000_000;
  const bot = new ArenaBot(cfg, {
    connect: () => socket as unknown as any,
    fetchQueue: async () => queue,
    log: () => {},
    now: () => clock,
  });
  return {
    bot, socket,
    setQueue: (q: Partial<QueueSnapshot>) => { queue = { length: 1, oldestWaitMs: 0, entries: [], ...q }; },
    advance: (ms: number) => { clock += ms; },
    /** start + open + register, the normal steady state. */
    async ready() {
      bot.start();
      socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ArenaBot queueing policy', () => {
  it('registers with the relay on connect', async () => {
    const h = harness();
    h.bot.start();
    h.socket.emit('open');
    // Must NOT register before the server has given us a session.
    expect(h.socket.lastOfType('REGISTER_BOT')).toBeUndefined();
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
    expect(h.socket.lastOfType('REGISTER_BOT')).toMatchObject({ token: 'tok' });
    h.bot.stop();
  });

  it('does not queue while nobody is waiting', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 0, oldestWaitMs: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });

  it('does not queue below the join threshold', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 19_999 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    h.bot.stop();
  });

  it('offers a game once someone has waited past the threshold', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 20_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING')).toMatchObject({ cardIds: CARDS });
    expect(h.bot.getStats().state).toBe('queued');
    h.bot.stop();
  });

  it('queues only once while still waiting for a match', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 30_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });

  it('leaves the queue if no match forms — otherwise it would ambush the next player', async () => {
    const h = harness(makeConfig({ queueTimeoutMs: 10_000 }));
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 25_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.bot.getStats().state).toBe('queued');

    h.advance(11_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket.lastOfType('CANCEL_MATCHMAKING')).toBeTruthy();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });

  it('does not take a second game while already playing', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('playing');
    h.bot.stop();
  });
});

describe('ArenaBot play', () => {
  it('plays a legal move when it is its turn', async () => {
    const h = harness();
    await h.ready();
    // The bot joins as player 2, so it acts on a board where it is its turn.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: botTurnState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);

    const placed = h.socket.lastOfType('PLACE_CARD');
    expect(placed).toBeTruthy();
    expect(placed.gameId).toBe('g1');
    // botTurnState already has player 1's opening card, so ours is move 1.
    expect(placed.moveNumber).toBe(1);
    expect(placed.handIndex).toBeGreaterThanOrEqual(0);
    expect(placed.handIndex).toBeLessThan(5);
    expect(placed.row).toBeGreaterThanOrEqual(0);
    expect(placed.col).toBeLessThan(3);
    h.bot.stop();
  });

  it('stays silent when it is the opponent\'s turn', async () => {
    const h = harness();
    await h.ready();
    // Fresh board: it is player1's turn, so the bot must stay silent.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('ignores state for a game it is not in', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'OTHER', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });

  it('does not send a move that the game outran during the pacing delay', async () => {
    const h = harness(makeConfig({ moveDelayMs: 5_000 }));
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // Game ends before the delayed move fires.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });
});

describe('ArenaBot outcome accounting', () => {
  // The bot only ever JOINS, so it is always player 2.
  const outcomes: [string, 'player1' | 'player2' | 'draw', keyof ReturnType<ArenaBot['getStats']>][] = [
    ['win', 'player2', 'wins'],
    ['loss', 'player1', 'losses'],
    ['draw', 'draw', 'draws'],
  ];

  for (const [label, winner, field] of outcomes) {
    it(`records a ${label}`, async () => {
      const h = harness();
      await h.ready();
      h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
      h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner, gameState: freshState() });
      const stats = h.bot.getStats();
      expect(stats.gamesPlayed).toBe(1);
      expect(stats[field]).toBe(1);
      expect(stats.state).toBe('idle');
      h.bot.stop();
    });
  }

  it('resets to idle and counts a join failure when the server rejects the queue', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 25_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.bot.getStats().state).toBe('queued');

    h.socket.deliver({ type: 'ERROR', message: 'You are already in the matchmaking queue' });
    const stats = h.bot.getStats();
    expect(stats.state).toBe('idle');
    expect(stats.joinFailures).toBe(1);
    expect(stats.lastError).toContain('already in the matchmaking queue');
    h.bot.stop();
  });

  it('does not wedge in playing when the socket drops mid-game', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    expect(h.bot.getStats().state).toBe('playing');
    h.socket.close();
    expect(h.bot.getStats().state).toBe('idle');
    h.bot.stop();
  });
});

/** Well-formed field hex: the settlement args builder really parses these. */
const FIELD = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const SIX_RANDOM = Array.from({ length: 6 }, (_, i) => FIELD(0x100 + i));

/** Minimal fake of the chain adapter, recording what the bot asks of it. */
function fakeChain(over: Partial<Record<string, any>> = {}) {
  const calls: any[] = [];
  return {
    calls,
    chain: {
      address: '0xbot',
      selectHand: over.selectHand ?? (async () => [7, 8, 9, 10, 11]),
      pxe: {
        previewCreateGame: over.previewCreateGame ?? (async () => ({
          gameId: FIELD(0xabc), randomness: SIX_RANDOM, blindingFactor: FIELD(0xb), status: 0,
        })),
        previewJoinGame: over.previewJoinGame ?? (async () => ({ randomness: SIX_RANDOM, blindingFactor: FIELD(0xb) })),
        sendCreateGame: over.sendCreateGame ?? (async (...a: any[]) => { calls.push(['create', ...a]); return '0xtxcreate'; }),
        sendJoinGame: over.sendJoinGame ?? (async (...a: any[]) => { calls.push(['join', ...a]); return '0xtxjoin'; }),
        sendProcessGame: over.sendProcessGame ?? (async (...a: any[]) => { calls.push(['settle', ...a]); return '0xtxsettle'; }),
        sendCancelGame: over.sendCancelGame ?? (async (...a: any[]) => { calls.push(['cancel', ...a]); return '0xtxcancel'; }),
      },
    },
  };
}

describe('ArenaBot chain mode', () => {
  const chainHarness = (over: Partial<Record<string, any>> = {}, cfg = makeConfig()) => {
    const socket = new FakeSocket();
    const f = fakeChain(over);
    let queue: QueueSnapshot = { length: 1, oldestWaitMs: 30_000, entries: [] };
    const bot = new ArenaBot(cfg, {
      connect: () => socket as unknown as any,
      fetchQueue: async () => queue,
      chain: f.chain as any,
      log: () => {},
      now: () => 1_000_000,
    });
    return { bot, socket, f, async ready() {
      bot.start();
      socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(0);
    } };
  };

  it('wagers cards it actually holds, not a static configured hand', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    // makeConfig's handCardIds are [1..5]; the chain says it holds [7..11].
    expect(h.socket.lastOfType('QUEUE_MATCHMAKING').cardIds).toEqual([7, 8, 9, 10, 11]);
  });

  it('does not queue when it cannot field five cards', async () => {
    const h = chainHarness({ selectHand: async () => { throw new Error('holds only 3 card(s)'); } });
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(h.bot.getStats().state).toBe('idle');
    expect(h.bot.getStats().joinFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/holds only 3/);
  });



  it('as player2: does NOT join on the shared id alone — that races the chain', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);

    // P1 shares its id EARLY, before its create_game has mined.
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: FIELD(0xc1) });
    await vi.advanceTimersByTimeAsync(50);
    // join_game asserts the game is in `created` state, so joining now would
    // fail "Game not in created state".
    expect(h.f.calls.some(c => c[0] === 'join')).toBe(false);
  });

  it('leaves immediately if the server ever assigns it the creator slot', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);

    // The server orders every pair so a bot is never the creator. If that ever
    // failed, the bot must NOT quietly start creating games — creating wagers
    // five cards as player 1, which is exactly what we promised it never does.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);

    expect(h.socket.lastOfType('CANCEL_GAME')).toMatchObject({ gameId: 'g1' });
    expect(h.bot.getStats().lastError).toMatch(/only joins/);
    expect(h.f.calls.some((c: any[]) => c[0] === 'create' || c[0] === 'join')).toBe(false);
  });

  it('as player2: joins once the opponent\'s create_game is confirmed', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: FIELD(0xc1) });
    await vi.advanceTimersByTimeAsync(50);

    h.socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.f.calls.some(c => c[0] === 'join')).toBe(true);
    expect(h.socket.lastOfType('TX_CONFIRMED')).toMatchObject({ txType: 'join_game' });
  });

  it('as player2: a repeated confirmation does not double-join', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: FIELD(0xc1) });
    for (let i = 0; i < 3; i++) {
      h.socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(h.f.calls.filter(c => c[0] === 'join')).toHaveLength(1);
  });

});

describe('ArenaBot proof flow', () => {
  function fakeProofs() {
    const calls: any[] = [];
    return {
      calls,
      proofs: {
        cardCommitHash: async (ids: number[]) => `0xcommit-${ids.join('')}`,
        verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
        proveHand: async (i: any) => { calls.push(['hand', i]); return { proof: 'p', publicInputs: ['a', 'b'], cardCommit: `0xcommit-${i.cardIds.join('')}` }; },
        proveMove: async (a: any) => { calls.push(['move', a]); return { proof: 'p', publicInputs: new Array(6).fill('x') }; },
      },
    };
  }

  const h2 = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const p = fakeProofs();
    const bot = new ArenaBot(makeConfig(over), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: p.proofs as any,
      log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f, p, async ready() {
      bot.start(); socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await vi.advanceTimersByTimeAsync(1_000);
    } };
  };

  it('waits for the opponent randomness before proving its hand', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    // Nothing shared yet: as the joiner we have neither our own preview nor the
    // opponent's randomness, so no hand proof is possible.
    expect(h.p.calls.some(c => c[0] === 'hand')).toBe(false);

    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.p.calls.some(c => c[0] === 'hand')).toBe(true);
    expect(h.socket.lastOfType('SUBMIT_HAND_PROOF')).toBeTruthy();
  });

  it('submits exactly one hand proof however many times inputs re-arrive', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    for (let i = 0; i < 3; i++) {
      deliverJoinHandshake(h.socket);
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(1);
  });

  it('will not even PLACE a card until both card commitments are known', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    // Our turn, our cards committed, our own hand proof done — but the
    // opponent's commitment has not arrived. A move proof binds BOTH, and it
    // needs the EXACT post-move board, so a card played now could never be
    // proved: not then, and not later once the board has moved on. One
    // unprovable move makes the whole game unsettleable, so the bot must HOLD.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);

    // The opponent's hand proof releases it. Nothing else can: the relay only
    // pushes a state when somebody moves, and the missing move is ours.
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);

    // …and that move is now provable.
    const placed = h.socket.lastOfType('PLACE_CARD');
    const st: any = botTurnState();
    st.board[placed.row][placed.col] = { card: { id: 1 }, owner: 'player2', originalOwner: 'player2' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: st });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.p.calls.some(c => c[0] === 'move')).toBe(true);
  });

  it('releases a held turn when OUR hand proof is the one that lands last', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // Opponent's commitment first, ours still in flight — the mirror image of
    // the case above. Whichever lands second must release the turn; only
    // covering one direction deadlocks the bot on the other.
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);

    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
  });

  it('clears per-game proof inputs so they cannot leak into the next game', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(1);

    // The bot is player 2 (it only joins). Winning means it attempts to settle;
    // the transcript is incomplete here so that attempt fails — and only THEN
    // does it reset, which is the window this test is about.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete/);

    // A second game must prove its own hand afresh, not reuse the first's state.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g2', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    // A DIFFERENT on-chain id: the bot's committedGameIds guard refuses to
    // re-commit one it has already handled, which is what we want in reality.
    deliverJoinHandshake(h.socket, 'g2', FIELD(0xc2));
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(2);
  });
});

describe('ArenaBot settlement', () => {
  // Real timers here: settle() awaits genuine dynamic imports of the Aztec SDK,
  // which fake timers cannot advance through.
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useFakeTimers());

  // The move-proof chain must start at the REAL canonical initial hash —
  // sortProofChain walks from it, so a made-up starting hash is rejected at
  // step 0 (which is the C2 replay guard doing its job).
  let initialHash: string;
  beforeAll(async () => {
    const { installNodeArtifactSources } = await import('../src/circuits.js');
    await installNodeArtifactSources();
    const { computeCanonicalInitialHash } = await import('../../frontend/src/aztec/settlementArgs.js');
    initialHash = await computeCanonicalInitialHash();
  }, 120_000);

  /** Well-formed field/address hex — buildProcessGameArgs really parses these. */
  const hex = FIELD;
  const CHAIN_GAME_ID = hex(0xabc);
  const OPP_ADDRESS = hex(0xdef);
  const RANDOMNESS = SIX_RANDOM;

  /** Valid base64 for N 32-byte field elements — the args builder really decodes it. */
  const fakeProofB64 = (fields = 4) => Buffer.alloc(32 * fields).toString('base64');

  function settleHarness(winner: string, playerNumber: 1 | 2, seedTranscript: boolean) {
    const socket = new FakeSocket();
    const f = fakeChain();
    const sent: any[] = [];
    const logs: string[] = [];
    f.chain.pxe.sendProcessGame = async (...a: any[]) => { sent.push(a); return '0xsettletx'; };
    const proofs = {
      cardCommitHash: async (ids: number[]) => `0xc-${ids.join('')}`,
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: fakeProofB64(), publicInputs: ['0x1', '0x2'], cardCommit: hex(0x111) }),
      proveMove: async () => ({ proof: fakeProofB64(), publicInputs: [], startStateHash: 'unused', endStateHash: '0x0' }),
    };
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20, settleWaitMs: 300 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: (m: string) => logs.push(m), now: () => Date.now(),
    });
    return { bot, socket, sent, logs, async run() {
      const settle = (ms: number) => new Promise(r => setTimeout(r, ms));
      bot.start(); socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      // Let the bot QUEUE first — that is what selects and stores its hand.
      // Skipping it leaves the hand empty and the hand proof never runs.
      await settle(80);
      socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber, gameState: freshState(), opponentIsBot: false });
      socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: OPP_ADDRESS, onChainGameId: CHAIN_GAME_ID, gameRandomness: RANDOMNESS });
      socket.deliver({ type: 'ON_CHAIN_STATUS', gameId: 'g1', status: { player1Tx: 'confirmed', player2Tx: 'pending' } });
      await settle(80);
      if (seedTranscript) {
        socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: playerNumber === 1 ? 2 : 1, handProof: { proof: fakeProofB64(), publicInputs: ['0x3', '0x4'], cardCommit: hex(0x222) } });
        let start = initialHash;
        for (let i = 0; i < 9; i++) {
          const end = `0x${String(i + 1).padStart(64, '0')}`;
          socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { proof: fakeProofB64(), publicInputs: [], startStateHash: start, endStateHash: end } });
          start = end;
        }
      }
      socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner, gameState: freshState(), player1CardIds: [1,2,3,4,5], player2CardIds: [6,7,8,9,10] });
      // Long enough for the settle wait (300ms) plus its 500ms poll tick.
      await settle(1200);
      bot.stop();
    } };
  }

  it('settles when it wins', async () => {
    const h = settleHarness('player2', 2, true);
    await h.run();
    expect(h.sent).toHaveLength(1);
    expect(h.bot.getStats().settlements).toBe(1);
  });

  it('does not settle when it loses — the winner does that', async () => {
    const h = settleHarness('player1', 2, true);
    await h.run();
    expect(h.sent).toHaveLength(0);
    expect(h.bot.getStats().settlements).toBe(0);
  });

  it('never settles a draw — draw settlement is player 1, and the bot only joins', async () => {
    // Draws are single-settler: player 1 alone fires winner_id=3, and a second
    // settler reverts (tests/draw-game.spec.ts). Since the bot is always the
    // JOINER it is never player 1, so the human settles every draw.
    const h = settleHarness('draw', 2, true);
    await h.run();
    expect(h.sent).toHaveLength(0);
  });

  it('names what is missing rather than sending an incomplete transcript', async () => {
    const h = settleHarness('player2', 2, false);
    await h.run();
    expect(h.sent).toHaveLength(0);
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete.*move proof/s);
  });
});

describe('ArenaBot commit gate', () => {
  it('does not play before its own cards are committed on-chain', async () => {
    const socket = new FakeSocket();
    // A commit that never resolves — the bot must simply not move.
    const f = fakeChain({ sendJoinGame: () => new Promise(() => {}) });
    const bot = new ArenaBot(makeConfig(), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);

    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    for (let i = 0; i < 5; i++) {
      socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: freshState() });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Moving here would prove against a commitment that does not exist yet, and
    // would let the relay game finish before the chain caught up.
    expect(socket.countOfType('PLACE_CARD')).toBe(0);
    bot.stop();
  });

  it('plays normally with no chain — off-chain mode is unaffected', async () => {
    const h = harness();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: botTurnState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });


  it('plays once committed, even if its turn arrived DURING the commit', async () => {
    const socket = new FakeSocket();
    let releaseCommit: (v: string) => void = () => {};
    const f = fakeChain({ sendJoinGame: () => new Promise<string>(r => { releaseCommit = r; }) });
    const bot = new ArenaBot(makeConfig(), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);

    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: botTurnState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    // Our turn arrives while the commit is still in flight — and is dropped.
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(0);

    // The relay sends a new state only when somebody MOVES, so nothing further
    // will arrive. Committing must replay the last state or the bot deadlocks.
    releaseCommit('0xtx');
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(1);
    bot.stop();
  });
});

describe('ArenaBot card shortage', () => {
  it('logs a persistent shortage once, but counts every occurrence', async () => {
    const socket = new FakeSocket();
    const logs: string[] = [];
    const f = fakeChain({ selectHand: async () => { throw new Error('holds only 2 card(s)'); } });
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: m => logs.push(m), now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);

    // The shortage persists until someone re-provisions; tick() runs constantly.
    const shortageLogs = logs.filter(l => l.includes('select-hand'));
    expect(shortageLogs).toHaveLength(1);
    expect(bot.getStats().joinFailures).toBeGreaterThan(1);
    expect(bot.getStats().lastError).toMatch(/holds only 2/);
    bot.stop();
  });
});

describe('ArenaBot queue race', () => {
  it('does not re-queue when a match lands during the /queue fetch', async () => {
    const socket = new FakeSocket();
    let releaseFetch: (v: QueueSnapshot) => void = () => {};
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50 }), {
      connect: () => socket as unknown as any,
      fetchQueue: () => new Promise<QueueSnapshot>(r => { releaseFetch = r; }),
      log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);

    // Match arrives while the queue fetch is still in flight.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    releaseFetch({ length: 1, oldestWaitMs: 30_000, entries: [] });
    await vi.advanceTimersByTimeAsync(100);

    // Queueing now would be rejected "already in an active game", and the ERROR
    // path would then reset us out of a game we are actually playing.
    expect(socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    expect(bot.getStats().state).toBe('playing');
    bot.stop();
  });
});

describe('ArenaBot move proof staleness', () => {
  it('will not prove against a LATER board than the one its move produced', async () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const proved: any[] = [];
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async (a: any) => { proved.push(a); return { proof: 'p', publicInputs: [], startStateHash: 's' }; },
    };
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 20 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(1);

    // A board TWO moves past ours. The bot moved on a board that already had 1
    // card, so its own after-state has 2; this has 4, by which point its card
    // may have been captured — owner no longer us, and the circuit rejects it.
    const late: any = botTurnState();
    late.board[0][1] = { card: { id: 6 }, owner: 'player1', originalOwner: 'player2' };
    late.board[0][2] = { card: { id: 7 }, owner: 'player1', originalOwner: 'player1' };
    late.board[1][0] = { card: { id: 8 }, owner: 'player2', originalOwner: 'player2' };
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: late });
    await vi.advanceTimersByTimeAsync(50);
    expect(proved).toHaveLength(0);
    bot.stop();
  });
});

describe('ArenaBot stuck-game watchdog', () => {
  it('abandons a stuck game and reports the cards left committed', async () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const cancels: any[] = [];
    f.chain.pxe.sendCancelGame = async (...a: any[]) => { cancels.push(a); return '0xcancel'; };
    let clock = 1_000_000;
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50, gameTimeoutMs: 10_000 }), {
      connect: () => socket as unknown as any,
      // A waiting player, so the bot QUEUES and thereby selects its hand —
      // without that there is no wagered hand to recover.
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, log: () => { /* quiet */ }, now: () => clock,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);

    // Joined and committed, then the game simply never finishes.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(socket);
    await vi.advanceTimersByTimeAsync(100);
    expect(bot.getStats().state).toBe('playing');

    clock += 11_000;
    await vi.advanceTimersByTimeAsync(200);

    // Without this the bot would sit in `playing` forever, taking no further
    // players, with its five committed cards stranded. Back in service means
    // idle OR already re-queued for the next waiting player.
    expect(['idle', 'queued']).toContain(bot.getStats().state);
    expect(bot.getStats().abandonedGames).toBe(1);
    // The bot only JOINS, so it cannot cancel (creator-only). Its committed
    // cards stay locked pending the abandonment claim — surfaced, not silent.
    expect(cancels).toHaveLength(0);
    expect(bot.getStats().cardsStranded).toBe(5);
    bot.stop();
  });

  it('does not try to cancel a game the opponent actually joined', async () => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const cancels: any[] = [];
    f.chain.pxe.sendCancelGame = async (...a: any[]) => { cancels.push(a); return '0xcancel'; };
    let clock = 1_000_000;
    const bot = new ArenaBot(makeConfig({ pollIntervalMs: 50, gameTimeoutMs: 10_000 }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 0, oldestWaitMs: 0, entries: [] }),
      chain: f.chain as any, log: () => {}, now: () => clock,
    });
    bot.start();
    socket.emit('open');
    socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(100);
    // As player2 we are the joiner — cancel_game is creator-only, and a joined
    // game needs the abandonment-claim path instead.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(100);
    clock += 11_000;
    await vi.advanceTimersByTimeAsync(200);

    expect(['idle', 'queued']).toContain(bot.getStats().state);
    expect(bot.getStats().abandonedGames).toBe(1);
    expect(cancels).toHaveLength(0);
    bot.stop();
  });
});

describe('ArenaBot join-only policy', () => {
  it('defaults to a 30s wait before offering itself', async () => {
    const { configFromEnv } = await import('../src/config.js');
    const cfg = configFromEnv({ ARENA_BOT_TOKEN: 't' } as NodeJS.ProcessEnv);
    expect(cfg.joinThresholdMs).toBe(30_000);
  });

  it('does not offer a game at 29s, but does at 30s', async () => {
    const h = harness(makeConfig({ joinThresholdMs: 30_000 }));
    await h.ready();
    h.setQueue({ length: 1, oldestWaitMs: 29_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);

    h.setQueue({ length: 1, oldestWaitMs: 30_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });
});

describe('ArenaBot one move per turn', () => {
  const mk = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig({ difficulty: 'random', ...over }), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f };
  };

  /** start → registered → committed → both card commitments known. */
  async function playing(h: ReturnType<typeof mk>) {
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    await vi.advanceTimersByTimeAsync(200);
  }

  it('schedules exactly one PLACE_CARD when a turn is signalled twice', async () => {
    const h = mk();
    await playing(h);

    // Our turn, signalled twice. In production the second signal is any of the
    // several callers of maybeMove — a re-broadcast state, our own hand proof
    // completing, the opponent's arriving — landing inside the pacing delay.
    // Without a guard both schedule, and under difficulty 'random' the second
    // picks a DIFFERENT cell: the relay applies the first, `pendingMove`
    // describes the second, and no echoed board ever matches it again. The bot
    // then stops proving AND stops playing. That deadlock cost a chain run.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });

  it('still plays the NEXT turn', async () => {
    const h = mk();
    await playing(h);
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: botTurnState() });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);

    // A board with 3 cards: our turn again, two moves later. The guard is
    // monotonic, so it must not block this.
    const later: any = botTurnState();
    later.board[2][2] = { card: { id: 9 }, owner: 'player2', originalOwner: 'player2' };
    later.board[2][1] = { card: { id: 10 }, owner: 'player1', originalOwner: 'player1' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: later });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(2);
    h.bot.stop();
  });
});

describe('ArenaBot journals committed games', () => {
  function journalSpy() {
    const written: any[] = [];
    const forgotten: string[] = [];
    const store = new Map<string, any>();
    return {
      written, forgotten,
      journal: {
        read: (id: string) => store.get(id) ?? null,
        write: (rec: any) => { store.set(rec.onChainGameId, rec); written.push(rec); },
        forget: (id: string) => { store.delete(id); forgotten.push(id); },
      },
    };
  }

  const mk = (over: any = {}) => {
    const socket = new FakeSocket();
    const f = fakeChain();
    const j = journalSpy();
    const proofs = {
      cardCommitHash: async () => FIELD(0x1),
      verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
      proveHand: async () => ({ proof: 'p', publicInputs: ['a', 'b'], cardCommit: FIELD(0x1) }),
      proveMove: async () => ({ proof: 'p', publicInputs: [], startStateHash: 's' }),
    };
    const bot = new ArenaBot(makeConfig(over), {
      connect: () => socket as unknown as any,
      fetchQueue: async () => ({ length: 1, oldestWaitMs: 30_000, entries: [] }),
      chain: f.chain as any, proofs: proofs as any, journal: j.journal,
      log: () => {}, now: () => 1_000_000,
    });
    return { bot, socket, f, j };
  };

  it('records the game the moment its cards are committed', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    // The cards are locked from the join onward; a crash a second later must
    // still leave a record, or they can never be recovered.
    expect(h.j.written.length).toBeGreaterThan(0);
    expect(h.j.written[0]).toMatchObject({
      onChainGameId: FIELD(0xc1),
      botIsPlayer1: false,
      cardIds: [7, 8, 9, 10, 11],
    });
    h.bot.stop();
  });

  it('grows the record as the transcript arrives', async () => {
    const h = mk();
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    h.socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 1, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    h.socket.deliver({ type: 'MOVE_PROVEN', gameId: 'g1', moveProof: { proof: 'm', publicInputs: [], startStateHash: 'x' } });
    await vi.advanceTimersByTimeAsync(50);

    const last = h.j.written[h.j.written.length - 1];
    expect(last.opponentHandProof).toBeTruthy();
    expect(last.myHandProof).toBeTruthy();
    expect(last.moveProofs.length).toBeGreaterThan(0);
    h.bot.stop();
  });

  it('does NOT forget a game whose settlement FAILED — the cards are still locked', async () => {
    const h = mk({ settleWaitMs: 0 });
    h.bot.start();
    h.socket.emit('open');
    h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'b', sessionToken: 't' });
    h.socket.deliver({ type: 'BOT_REGISTERED' });
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    deliverJoinHandshake(h.socket);
    await vi.advanceTimersByTimeAsync(50);

    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(200);

    // The transcript was incomplete, so the settle failed. Forgetting here
    // would delete the only record that five cards are committed, and the
    // sweep would never come back for them.
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().settlements).toBe(0);
    expect(h.j.forgotten).toEqual([]);
    h.bot.stop();
  });
});

describe('ArenaBot pool behaviour', () => {
  it('does not offer when another bot is already covering the waiting player', async () => {
    const h = harness();
    await h.ready();
    // One human waiting, one bot already queued for them. A second offer just
    // parks five more committed cards in the queue doing nothing.
    h.setQueue({ length: 2, oldestWaitMs: 60_000, humansWaiting: 1, botsQueued: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(0);
    h.bot.stop();
  });

  it('offers when there are more waiting humans than bots', async () => {
    const h = harness();
    await h.ready();
    h.setQueue({ length: 3, oldestWaitMs: 60_000, humansWaiting: 2, botsQueued: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });

  it('offers against an older relay that reports no bot counts', async () => {
    const h = harness();
    await h.ready();
    // Without the fields, a single-bot deployment is the right assumption —
    // refusing to play would be a worse failure than a rare double-offer.
    h.setQueue({ length: 1, oldestWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.socket.countOfType('QUEUE_MATCHMAKING')).toBe(1);
    h.bot.stop();
  });
});
