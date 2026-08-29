import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    chainTxTimeoutMs: 600_000, ...over,
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
          gameId: '0xgame', randomness: ['0xr1'], blindingFactor: '0xb', status: 0,
        })),
        previewJoinGame: over.previewJoinGame ?? (async () => ({ randomness: ['0xr2'], blindingFactor: '0xb' })),
        sendCreateGame: over.sendCreateGame ?? (async (...a: any[]) => { calls.push(['create', ...a]); return '0xtxcreate'; }),
        sendJoinGame: over.sendJoinGame ?? (async (...a: any[]) => { calls.push(['join', ...a]); return '0xtxjoin'; }),
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
    expect(shared).toMatchObject({ gameId: 'g1', aztecAddress: '0xbot', onChainGameId: '0xgame' });
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

  it('as player2: joins only once the opponent shares the on-chain id', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.f.calls.some(c => c[0] === 'join')).toBe(false);

    h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: '0xchain1' });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.f.calls.some(c => c[0] === 'join')).toBe(true);
    expect(h.socket.lastOfType('TX_CONFIRMED')).toMatchObject({ txType: 'join_game' });
  });

  it('as player2: a repeated opponent-info message does not double-join', async () => {
    const h = chainHarness();
    await h.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    h.socket.deliver({ type: 'MATCH_FOUND', gameId: 'g1', playerNumber: 2, gameState: freshState(), opponentIsBot: false });
    for (let i = 0; i < 3; i++) {
      h.socket.deliver({ type: 'OPPONENT_AZTEC_INFO', gameId: 'g1', aztecAddress: '0xhuman', onChainGameId: '0xchain1' });
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
