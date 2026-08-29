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
    moveDelayMs: 0,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
    settleWaitMs: 1_000,
    gameTimeoutMs: 1_800_000,
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

  constructor(url: string) { this.ws = new WebSocket(url); openSockets.push(this.ws); }

  /** Resolves once the server has established our session (not merely on open). */
  async ready(): Promise<void> {
    await new Promise<void>(res => this.ws.once('open', () => res()));
    const established = new Promise<void>(res => {
      const onMsg = (raw: any) => {
        if (JSON.parse(raw.toString()).type === 'SESSION_ESTABLISHED') {
          this.ws.off('message', onMsg);
          res();
        }
      };
      this.ws.on('message', onMsg);
    });
    this.ws.on('message', raw => this.handle(JSON.parse(raw.toString())));
    await established;
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
