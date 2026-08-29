import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import { ArenaBot, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import { createGame, getCardsByIds } from '@axolotl-arena/game-logic';
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
    gameTimeoutMs: 1_800_000,
    healthPort: 0,
    ...over,
  };
}

function freshState(): GameState {
  return createGame(getCardsByIds(CARDS), getCardsByIds(CARDS));
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
    // Fresh game: player1 moves first, so the bot as player1 must act.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(10);

    const placed = h.socket.lastOfType('PLACE_CARD');
    expect(placed).toBeTruthy();
    expect(placed.gameId).toBe('g1');
    expect(placed.moveNumber).toBe(0);
    expect(placed.handIndex).toBeGreaterThanOrEqual(0);
    expect(placed.handIndex).toBeLessThan(5);
    expect(placed.row).toBeGreaterThanOrEqual(0);
    expect(placed.col).toBeLessThan(3);
    h.bot.stop();
  });

  it('stays silent when it is the opponent\'s turn', async () => {
    const h = harness();
    await h.ready();
    // Bot is player2 but it is player1's turn.
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
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    // Game ends before the delayed move fires.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player2', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(0);
    h.bot.stop();
  });
});

describe('ArenaBot outcome accounting', () => {
  const outcomes: [string, 'player1' | 'player2' | 'draw', keyof ReturnType<ArenaBot['getStats']>][] = [
    ['win', 'player1', 'wins'],
    ['loss', 'player2', 'losses'],
    ['draw', 'draw', 'draws'],
  ];

  for (const [label, winner, field] of outcomes) {
    it(`records a ${label}`, async () => {
      const h = harness();
      await h.ready();
      h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
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
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
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

  it('as player1: shares the derived game id BEFORE the slow tx, then confirms', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);

    const shared = h.socket.lastOfType('SHARE_AZTEC_INFO');
    expect(shared).toMatchObject({ gameId: 'g1', aztecAddress: '0xbot', onChainGameId: FIELD(0xabc) });
    expect(h.f.calls.some(c => c[0] === 'create')).toBe(true);
    expect(h.socket.lastOfType('TX_CONFIRMED')).toMatchObject({ txType: 'create_game', txHash: '0xtxcreate' });
  });

  it('as player1: refuses to commit onto a stale note nonce', async () => {
    const h = chainHarness({ previewCreateGame: async () => ({ gameId: '0xg', randomness: [], blindingFactor: '0x', status: 2 }) });
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.f.calls.some(c => c[0] === 'create')).toBe(false);
    expect(h.bot.getStats().commitFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/status 2/);
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

  it('as player1: does not commit when it is player2, and vice versa', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.f.calls.some(c => c[0] === 'create')).toBe(false);
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
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    // Our own preview has landed, but the opponent has shared nothing yet.
    expect(h.p.calls.some(c => c[0] === 'hand')).toBe(false);

    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xh', gameRandomness: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.p.calls.some(c => c[0] === 'hand')).toBe(true);
    expect(h.socket.lastOfType('SUBMIT_HAND_PROOF')).toBeTruthy();
  });

  it('submits exactly one hand proof however many times inputs re-arrive', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    for (let i = 0; i < 3; i++) {
      h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xh', gameRandomness: ['r', 'r', 'r', 'r', 'r', 'r'] });
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(1);
  });

  it('proves its own move only once both card commitments are known', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xh', gameRandomness: ['r', 'r', 'r', 'r', 'r', 'r'] });
    await vi.advanceTimersByTimeAsync(50);

    // Play is gated on OUR commit, so the move only goes out on a later state.
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    const placed = h.socket.lastOfType('PLACE_CARD');
    expect(placed, 'moves once committed').toBeTruthy();

    // Echo a state containing that move. The opponent's commitment is still
    // unknown, and the move proof binds BOTH — so it must not prove yet.
    const st: any = freshState();
    st.board[placed.row][placed.col] = { card: { id: 1 }, owner: 'player1', originalOwner: 'player1' };
    h.socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: st });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.p.calls.some(c => c[0] === 'move')).toBe(false);
  });

  it('clears per-game proof inputs so they cannot leak into the next game', async () => {
    const h = h2();
    await h.ready();
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xh', gameRandomness: ['r', 'r', 'r', 'r', 'r', 'r'] });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('SUBMIT_HAND_PROOF')).toBe(1);

    // Bot is player1 and 'won', so it attempts to settle. The transcript is
    // incomplete here, so that attempt fails — and only THEN does it reset.
    h.socket.deliver({ type: 'GAME_OVER', gameId: 'g1', winner: 'player1', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.bot.getStats().settleFailures).toBe(1);
    expect(h.bot.getStats().lastError).toMatch(/transcript incomplete/);

    // A second game must prove its own hand afresh, not reuse the first's state.
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g2', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g2', aztecAddress: '0xh', gameRandomness: ['s', 's', 's', 's', 's', 's'] });
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
      await settle(50);
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
    const h = settleHarness('player1', 1, true);
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

  it('settles a draw only as player 1 — a second settler would revert', async () => {
    const asP1 = settleHarness('draw', 1, true);
    await asP1.run();
    expect(asP1.sent).toHaveLength(1);

    const asP2 = settleHarness('draw', 2, true);
    await asP2.run();
    expect(asP2.sent).toHaveLength(0);
  });

  it('names what is missing rather than sending an incomplete transcript', async () => {
    const h = settleHarness('player1', 1, false);
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
    const f = fakeChain({ sendCreateGame: () => new Promise(() => {}) });
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

    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
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
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.socket.countOfType('PLACE_CARD')).toBe(1);
    h.bot.stop();
  });


  it('plays once committed, even if its turn arrived DURING the commit', async () => {
    const socket = new FakeSocket();
    let releaseCommit: (v: string) => void = () => {};
    const f = fakeChain({ sendCreateGame: () => new Promise<string>(r => { releaseCommit = r; }) });
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

    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    // Our turn arrives while the commit is still in flight — and is dropped.
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: freshState() });
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
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
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
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xh', onChainGameId: FIELD(0xc), gameRandomness: SIX_RANDOM });
    socket.deliver({ type: 'HAND_PROOF', gameId: 'g1', fromPlayer: 2, handProof: { proof: 'q', publicInputs: [], cardCommit: FIELD(0x2) } });
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: freshState() });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.countOfType('PLACE_CARD')).toBe(1);

    // A state TWO moves on: our card may have been captured, so its owner would
    // no longer be us and the circuit would reject the proof.
    const late: any = freshState();
    late.board[0][0] = { card: { id: 1 }, owner: 'player2', originalOwner: 'player1' };
    late.board[0][1] = { card: { id: 6 }, owner: 'player2', originalOwner: 'player2' };
    socket.deliver({ type: 'GAME_STATE', gameId: 'g1', gameState: late });
    await vi.advanceTimersByTimeAsync(50);
    expect(proved).toHaveLength(0);
    bot.stop();
  });
});

describe('ArenaBot stuck-game watchdog', () => {
  it('abandons a game that never finishes and recovers its cards', async () => {
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

    // Matched as creator, commits, and the opponent then never joins.
    socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 1, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(bot.getStats().state).toBe('playing');

    clock += 11_000;
    await vi.advanceTimersByTimeAsync(200);

    // Without this the bot would sit in `playing` forever, taking no further
    // players, with its five committed cards stranded. Back in service means
    // idle OR already re-queued for the next waiting player.
    expect(['idle', 'queued']).toContain(bot.getStats().state);
    expect(bot.getStats().abandonedGames).toBe(1);
    expect(cancels).toHaveLength(1);
    expect(cancels[0][2]).toHaveLength(5);       // the wagered hand
    expect(bot.getStats().cardsRecovered).toBe(5);
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
