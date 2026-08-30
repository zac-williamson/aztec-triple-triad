/**
 * End-to-end: a real backend, the real ArenaBot over a real WebSocket, and a
 * simulated human. Proves the whole phase-1/2 loop — the bot notices a waiting
 * player, offers itself, is matched by the server's ordinary matchmaking, and
 * plays a complete 9-move game to GAME_OVER.
 *
 * Off-chain only: no PXE, no proofs. Chain integration is phase 3.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer, type CardGameServer } from '@axolotl-arena/backend/src/server.js';
import * as metrics from '@axolotl-arena/backend/src/metrics.js';
import { ArenaBot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';

const HUMAN_CARDS = [6, 7, 8, 9, 10];
const BOT_CARDS = [1, 2, 3, 4, 5];
const TOKEN = 'test-bot-token';

let server: CardGameServer;
let port: number;
let bot: ArenaBot | null = null;
const openSockets: WebSocket[] = [];

function cfg(over: Partial<ArenaBotConfig> = {}): ArenaBotConfig {
  return {
    wsUrl: `ws://localhost:${port}`,
    httpUrl: `http://localhost:${port}`,
    token: TOKEN,
    joinThresholdMs: 50,      // keep the test fast; policy itself is unit-tested
    pollIntervalMs: 25,
    queueTimeoutMs: 30_000,
    handCardIds: BOT_CARDS,
    difficulty: 'greedy',
    // Deterministic strength: blundering at random would make move assertions
    // flaky for reasons unrelated to what is under test.
    skillMin: 1,
    skillMax: 1,
    moveDelayMs: 0,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
    settleWaitMs: 1_000,
    sweepIntervalMs: 900_000,
    drawFallbackMs: 0,
    gameTimeoutMs: 1_800_000,
    healthPort: 0,
    ...over,
  };
}

/** A scripted human: plays the first legal cell, hand slot 0, on its turn. */
class HumanClient {
  ws: WebSocket;
  gameId: string | null = null;
  me: 'player1' | 'player2' | null = null;
  over: { winner: string } | null = null;
  opponentIsBot: boolean | null = null;

  private established = false;
  private onEstablished: (() => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    openSockets.push(this.ws);
    // Listen from CONSTRUCTION, not from ready(). Attaching later loses any
    // message that already arrived, and nothing replays it: constructing two
    // clients and awaiting them in turn lets the second one's
    // SESSION_ESTABLISHED land while we are still awaiting the first, after
    // which ready() waits forever for an event that has been and gone. That was
    // a real ~1-in-6 hang in these tests, and it looked like a server fault.
    this.ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'SESSION_ESTABLISHED') {
        this.established = true;
        this.onEstablished?.();
      }
      this.handle(msg);
    });
  }

  /** Resolves once the server has established our session (not merely on open). */
  async ready(): Promise<void> {
    if (this.established) return;
    await new Promise<void>(res => { this.onEstablished = res; });
  }

  private handle(msg: any) {
    if (msg.type === 'MATCH_FOUND') {
      this.gameId = msg.gameId;
      this.me = msg.playerNumber === 1 ? 'player1' : 'player2';
      this.opponentIsBot = msg.opponentIsBot ?? null;
      this.move(msg.gameState);
    }
    if ((msg.type === 'GAME_STATE' || msg.type === 'GAME_START') && msg.gameId === this.gameId) {
      this.move(msg.gameState);
    }
    if (msg.type === 'GAME_OVER' && msg.gameId === this.gameId) this.over = { winner: msg.winner };
  }

  private move(state: any) {
    if (!state || state.status !== 'playing' || state.currentTurn !== this.me) return;
    const moveNumber = state.board.flat().filter((c: any) => c.card !== null).length;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (!state.board[row][col].card) {
          this.ws.send(JSON.stringify({
            type: 'PLACE_CARD', gameId: this.gameId, handIndex: 0, row, col, moveNumber,
          }));
          return;
        }
      }
    }
  }

  queue() { this.ws.send(JSON.stringify({ type: 'QUEUE_MATCHMAKING', cardIds: HUMAN_CARDS })); }
  close() { this.ws.close(); }
}

const waitFor = async (pred: () => boolean, ms = 15_000, label = 'condition') => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
};

beforeEach(async () => {
  // Counters are process-local and shared across tests in this file.
  metrics.reset();
  process.env.ARENA_BOT_TOKEN = TOKEN;
  port = 19000 + Math.floor(Math.random() * 2000);
  server = createServer({ port });
  await new Promise<void>(res => server.httpServer.listen(port, () => res()));
});

afterEach(async () => {
  bot?.stop();
  bot = null;
  for (const ws of openSockets) { try { ws.close(); } catch { /* already gone */ } }
  openSockets.length = 0;
  delete process.env.ARENA_BOT_TOKEN;
  // A still-open socket keeps the http server alive and times out the hook.
  await new Promise(r => setTimeout(r, 50));
  server.wss?.close?.();
  await new Promise<void>(res => server.httpServer.close(() => res()));
});

describe('arena bot end-to-end', () => {
  it('exposes queue state over /queue', async () => {
    const human = new HumanClient(`ws://localhost:${port}`);
    await human.ready();
    human.queue();
    await new Promise(r => setTimeout(r, 200));

    const snap = await (await fetch(`http://localhost:${port}/queue`)).json() as any;
    expect(snap.length).toBe(1);
    expect(snap.entries[0].waitMs).toBeGreaterThanOrEqual(0);
    human.close();
  });

  it('refuses bot registration with a bad token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    openSockets.push(ws);
    await new Promise<void>(res => ws.once('open', () => res()));
    const seen: any[] = [];
    ws.on('message', raw => seen.push(JSON.parse(raw.toString())));
    await waitFor(() => seen.some(m => m.type === 'SESSION_ESTABLISHED'), 5_000, 'session');
    ws.send(JSON.stringify({ type: 'REGISTER_BOT', token: 'wrong' }));
    await waitFor(() => seen.some(m => m.type === 'ERROR'), 5_000, 'refusal');
    expect(seen.some(m => m.type === 'BOT_REGISTERED')).toBe(false);
    ws.close();
  });

  it('does not offer a game before the threshold elapses', async () => {
    bot = new ArenaBot(cfg({ joinThresholdMs: 10_000 }), { log: () => {} });
    bot.start();
    const human = new HumanClient(`ws://localhost:${port}`);
    await human.ready();
    human.queue();
    await new Promise(r => setTimeout(r, 600));
    expect(bot.getStats().state).toBe('idle');
    expect(human.gameId).toBeNull();
    human.close();
  });

  it('rescues a waiting player and plays a full game to completion', async () => {
    bot = new ArenaBot(cfg(), { log: () => {} });
    bot.start();

    const human = new HumanClient(`ws://localhost:${port}`);
    await human.ready();
    human.queue();

    await waitFor(() => human.gameId !== null, 15_000, 'match to form');
    // The human must be TOLD the opponent is a bot.
    expect(human.opponentIsBot, 'bot opponent is disclosed to the human').toBe(true);

    await waitFor(() => human.over !== null, 30_000, 'game to finish');
    expect(['player1', 'player2', 'draw']).toContain(human.over!.winner);

    const stats = bot.getStats();
    expect(stats.gamesPlayed).toBe(1);
    expect(stats.wins + stats.losses + stats.draws).toBe(1);
    expect(stats.moveFailures).toBe(0);
    expect(stats.state).toBe('idle');

    // The bot must free itself for the next player.
    const m = await (await fetch(`http://localhost:${port}/metrics`)).json() as any;
    expect(m.matchesFormed).toBe(1);
    expect(m.botMatchesFormed).toBe(1);
    expect(m.gamesCompleted).toBe(1);
    // The bot outcome counters must actually MOVE — a monitoring counter stuck
    // at zero reads as "healthy" when it means "not measured".
    expect(m.botWins + m.botLosses + m.botDraws).toBe(1);
    // ...and agree with the bot's own view of the same game.
    expect(m.botWins).toBe(stats.wins);
    expect(m.botLosses).toBe(stats.losses);
    expect(m.botDraws).toBe(stats.draws);
    expect(m.meanMatchWaitMs).toBeGreaterThanOrEqual(0);
    human.close();
  }, 60_000);

  it('serves metrics before anything has happened', async () => {
    const m = await (await fetch(`http://localhost:${port}/metrics`)).json() as any;
    expect(m.matchesFormed).toBe(0);
    expect(m.queueLength).toBe(0);
    expect(typeof m.uptimeMs).toBe('number');
  });
});

/**
 * The pool. These run a REAL relay with several real bots on it, because the
 * failure they cover is an interaction between the two: N bots each polling the
 * same queue, and a matcher that will happily pair the first two entries it
 * finds. Neither side can see the problem alone.
 */
describe('a pool of arena bots', () => {
  const pool: ArenaBot[] = [];

  afterEach(() => {
    for (const b of pool) b.stop();
    pool.length = 0;
  });

  function startPool(n: number, over: Partial<ArenaBotConfig> = {}): ArenaBot[] {
    for (let i = 0; i < n; i++) {
      const b = new ArenaBot(cfg({ handCardIds: [1 + i * 5, 2 + i * 5, 3 + i * 5, 4 + i * 5, 5 + i * 5], ...over }));
      pool.push(b);
      b.start();
    }
    return pool;
  }

  it('never matches two bots against each other, however long they idle', async () => {
    startPool(3);
    // No human anywhere. Three bots polling a queue that only ever contains
    // other bots must produce no games at all — a bot exists to give a HUMAN an
    // opponent, and two of them playing each other burns ten committed cards.
    await new Promise(r => setTimeout(r, 2_000));

    expect(pool.every(b => b.getStats().gamesPlayed === 0)).toBe(true);
    expect(await server.gameManager.getGameCount()).toBe(0);
  }, 20_000);

  it('sends exactly ONE bot to a waiting human, not the whole pool', async () => {
    const human = new HumanClient(`ws://localhost:${port}`);
    await human.ready();
    startPool(3);
    human.queue();

    await waitFor(() => human.gameId !== null, 15_000, 'the human to be matched');
    // Wait for the losers of the race to be TOLD to stand down rather than
    // sleeping a guessed interval: a bot briefly holds state 'queued' between
    // sending its offer and receiving QUEUE_DECLINED, and a fixed sleep landing
    // inside that window fails for no real reason.
    await waitFor(
      () => pool.filter(b => b.getStats().state === 'queued').length === 0,
      10_000, 'the other bots to stand down',
    );
    // …then leave room for anything wrong to actually happen before asserting
    // that it did not.
    await new Promise(r => setTimeout(r, 1_000));

    expect(human.opponentIsBot).toBe(true);
    // The extras must not be parked in the queue holding five committed cards
    // each, waiting to time out.
    // "Engaged" rather than "playing": with moveDelayMs 0 the nine relay moves
    // fly through in milliseconds, so the bot may already be back to idle with
    // the game recorded.
    const engaged = pool.filter(b => {
      const st = b.getStats();
      return st.state === 'playing' || st.gamesPlayed > 0;
    }).length;
    const queued = pool.filter(b => b.getStats().state === 'queued').length;
    expect(engaged).toBe(1);
    // The extras must not be parked in the queue holding five committed cards.
    expect(queued).toBe(0);
    expect(await server.gameManager.getGameCount()).toBe(1);

    human.close();
  }, 30_000);

  it('puts the human in the creator slot even against a pool', async () => {
    startPool(2);
    // Bots are already polling; the human arrives after them.
    await new Promise(r => setTimeout(r, 500));
    const human = new HumanClient(`ws://localhost:${port}`);
    await human.ready();
    human.queue();

    await waitFor(() => human.me !== null, 15_000, 'a match');
    // Creating wagers five cards on a game nobody may join — never the bot.
    expect(human.me).toBe('player1');

    human.close();
  }, 30_000);

  it('two humans play EACH OTHER rather than each taking a bot', async () => {
    // A realistic threshold matters here: the whole point of making the bot wait
    // is to leave a window for a second human to arrive. With the 50ms the other
    // tests use, a bot claims the first human before the second even queues.
    startPool(2, { joinThresholdMs: 3_000 });
    const h1 = new HumanClient(`ws://localhost:${port}`);
    const h2 = new HumanClient(`ws://localhost:${port}`);
    await h1.ready(); await h2.ready();
    h1.queue(); h2.queue();

    await waitFor(() => h1.gameId !== null && h2.gameId !== null, 15_000, 'both humans matched');

    // The bot is a fallback for an empty queue, not a competitor for players.
    expect(h1.gameId).toBe(h2.gameId);
    expect(h1.opponentIsBot).toBe(false);
    expect(h2.opponentIsBot).toBe(false);
    expect(pool.every(b => b.getStats().gamesPlayed === 0)).toBe(true);

    h1.close(); h2.close();
  }, 30_000);
});
