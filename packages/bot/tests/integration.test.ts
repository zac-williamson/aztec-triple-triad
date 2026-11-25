/**
 * End-to-end over the wire: a real relay, the real ArenaBot on a real
 * WebSocket, and a scripted human playing a game the way a browser does now
 * the relay is a pipe (docs/plan/PRIVATE_GAMES.md section 6) — the real
 * WebCrypto key exchange, sealed records and open cards, sealed moves the
 * relay can only count, and the frontend's own checks of every move the bot
 * sends.
 *
 * The chain and the proofs are stood in for (fakes.ts): this is about the bot
 * and the relay agreeing on the protocol. The bot's chain path is covered in
 * the ArenaBot tests, and for real in chain-e2e.manual.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer, type CardGameServer } from '@axolotl-arena/backend/src/server.js';
import * as metrics from '@axolotl-arena/backend/src/metrics.js';
import { ArenaBot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import { FakeHuman, N, OUTCOMES, RECORD1, fakeChain, fakeProofs, type HumanStrategy } from './fakes.js';
import type { GameChannel, GameKeyPair } from '../../frontend/src/aztec/gameKeys.js';

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
    difficulty: 'greedy',
    // Deterministic strength and choices: the game's outcome is part of what
    // is asserted.
    skillMin: 1,
    skillMax: 1,
    moveSeed: 1,
    moveDelayMs: 0,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
    sweepIntervalMs: 900_000,
    drawFallbackMs: 0,
    gameTimeoutMs: 1_800_000,
    opponentGraceMs: 90_000,
    healthPort: 0,
    ...over,
  };
}

/** A bot on a fake chain and prover, talking to the real relay. Its sockets are kept, so a test can cut one. */
function startBot(over: Partial<ArenaBotConfig> = {}) {
  const f = fakeChain();
  // The creator's game is on-chain before they send their record.
  f.state.hits.set(N.created, 4);
  const sockets: WebSocket[] = [];
  const b = new ArenaBot(cfg(over), {
    chain: f.chain as never,
    proofs: fakeProofs().proofs,
    connect: url => { const ws = new WebSocket(url); sockets.push(ws); openSockets.push(ws); return ws; },
    log: () => {},
  });
  b.start();
  return { bot: b, f, sockets };
}

/**
 * A human at the relay. Queues; and, when `play` is set, plays the creator's
 * side as a browser does: key pair at MATCH_FOUND, its record once "created",
 * its open cards once the joiner's record arrives, then a sealed move on each
 * of its turns — each of the bot's moves checked first, exactly as the
 * browser checks it.
 */
class HumanClient {
  ws: WebSocket;
  gameId: string | null = null;
  me: 1 | 2 | null = null;
  /** MATCH_FOUND as it arrived. */
  match: Record<string, unknown> | null = null;
  /** Every frame the relay sent us, as it arrived. */
  readonly received: any[] = [];
  game: FakeHuman | null = null;
  error: Error | null = null;

  private keys: typeof import('../../frontend/src/aztec/gameKeys.js') | null = null;
  private keyPair: GameKeyPair | null = null;
  private channel: GameChannel | null = null;
  /** The joiner's record arrived. A resend (after its reconnect) changes nothing — as in the browser. */
  private joinerRecord = false;
  private established = false;
  private onEstablished: (() => void) | null = null;
  /** Our handling, one frame at a time, in order — as the browser's is. */
  private work: Promise<void> = Promise.resolve();

  constructor(url: string, private readonly opts: {
    play?: boolean;
    strategy?: HumanStrategy;
    /** Runs before each of our own moves goes out. */
    beforeOwnMove?: (moveNumber: number) => Promise<void>;
  } = {}) {
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
      this.received.push(msg);
      if (msg.type === 'SESSION_ESTABLISHED') {
        this.established = true;
        this.onEstablished?.();
      }
      this.work = this.work.then(() => this.handle(msg)).catch(err => { this.error ??= err as Error; });
    });
  }

  /** Resolves once the server has established our session (not merely on open). */
  async ready(): Promise<void> {
    if (this.established) return;
    await new Promise<void>(res => { this.onEstablished = res; });
  }

  private send(msg: unknown) { this.ws.send(JSON.stringify(msg)); }

  private async sendPeer(payload: unknown) {
    const sealed = await this.keys!.sealPeerPayload(this.channel!.channelKey, this.gameId!, payload);
    this.send({ type: 'PEER', gameId: this.gameId, ...sealed });
  }

  private async playOwn() {
    const game = this.game!;
    await this.opts.beforeOwnMove?.(game.moves.length);
    this.send(await game.move());
  }

  private async handle(msg: any) {
    if (msg.type === 'MATCH_FOUND') {
      this.gameId = msg.gameId;
      this.me = msg.playerNumber;
      this.match = msg;
    }
    if (!this.opts.play) return;
    switch (msg.type) {
      case 'MATCH_FOUND': {
        this.keys = await import('../../frontend/src/aztec/gameKeys.js');
        this.keyPair = await this.keys.generateGameKeyPair();
        this.send({ type: 'KEY_EXCHANGE', gameId: this.gameId, publicKey: this.keyPair.publicKey });
        return;
      }
      case 'OPPONENT_KEY': {
        const keys = this.keys!;
        const room = this.gameId!;
        const channel = await keys.deriveGameChannel(this.keyPair!, msg.publicKey, room);
        this.channel = channel;
        this.game = new FakeHuman({
          room,
          seal: payload => keys.sealPeerPayload(channel.channelKey, room, payload),
          open: sealed => keys.openPeerPayload(channel.channelKey, room, sealed),
          strategy: this.opts.strategy,
        });
        // Our create_game is "mined": say so, then send our record.
        this.send({ type: 'TX_CONFIRMED', gameId: room, txType: 'create_game' });
        await this.sendPeer({ kind: 'RECORD', record: RECORD1 });
        return;
      }
      case 'PEER': {
        const payload: any = await this.keys!.openPeerPayload(this.channel!.channelKey, this.gameId!, msg);
        if (payload.kind === 'RECORD') {
          if (this.joinerRecord) return;
          this.joinerRecord = true;
          // The bot joined: our open cards, then the first move.
          await this.sendPeer(this.game!.openCards());
          await this.playOwn();
        } else if (payload.kind === 'OPEN_CARDS') {
          await this.game!.receiveOpenCards(payload);
        }
        return;
      }
      case 'MOVE': {
        await this.game!.receive(msg);
        if (this.game!.moves.length < 9) await this.playOwn();
        return;
      }
    }
  }

  /** All nine moves are in our transcript. */
  get finished(): boolean { return (this.game?.moves.length ?? 0) >= 9; }

  queue() { this.send({ type: 'QUEUE_MATCHMAKING' }); }
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
    bot = startBot({ joinThresholdMs: 10_000 }).bot;
    const human = new HumanClient(`ws://localhost:${port}`);
    await human.ready();
    human.queue();
    await new Promise(r => setTimeout(r, 600));
    expect(bot.getStats().state).toBe('idle');
    expect(human.gameId).toBeNull();
    human.close();
  });

  it('rescues a waiting player and plays a whole game through the pipe — every move checked by both sides', async () => {
    const started = startBot();
    bot = started.bot;

    const human = new HumanClient(`ws://localhost:${port}`, { play: true, strategy: OUTCOMES.loss });
    await human.ready();
    human.queue();

    await waitFor(() => human.gameId !== null, 15_000, 'match to form');
    // A room and a seat — no game state, and nothing that says the opponent is
    // a bot: a player must not be able to tell, not even from this frame.
    expect(Object.keys(human.match!).sort()).toEqual(['gameId', 'playerNumber', 'type']);
    expect(human.me).toBe(1);

    await waitFor(() => human.finished || human.error !== null, 30_000, 'the ninth move');
    expect(human.error).toBeNull();
    await waitFor(() => bot!.getStats().gamesPlayed === 1, 10_000, 'the bot to see the result');

    // Every move the bot received through the relay was a number and ciphertext.
    for (const m of human.received.filter(x => x.type === 'MOVE')) {
      expect(Object.keys(m).sort()).toEqual(['ciphertext', 'gameId', 'iv', 'moveNumber', 'type']);
    }
    // The bot reports its own result: the relay cannot know it.
    const stats = bot.getStats();
    expect(stats).toMatchObject({ gamesPlayed: 1, losses: 1, wins: 0, draws: 0, opponentFaults: 0, moveFailures: 0, proofFailures: 0 });
    expect(['idle', 'queued'], 'the bot must free itself for the next player').toContain(stats.state);
    expect(started.f.called('join')).toHaveLength(1);

    const m = await (await fetch(`http://localhost:${port}/metrics`)).json() as any;
    expect(m.matchesFormed).toBe(1);
    expect(m.botMatchesFormed).toBe(1);
    expect(m.gamesCompleted, 'all nine moves went through the relay').toBe(1);
    expect(m.meanMatchWaitMs).toBeGreaterThanOrEqual(0);
    // Win/loss counters are gone from the relay: it never sees a result.
    expect(m).not.toHaveProperty('botWins');
    expect(m).not.toHaveProperty('botLosses');
    human.close();
  }, 60_000);

  it('resumes its seat when its socket drops mid-game, and the game still completes', async () => {
    // A slower reconnect, so the human's next move lands while the bot is away
    // and has to come from the relay's buffer.
    const started = startBot({ pollIntervalMs: 300 });
    bot = started.bot;

    const human: HumanClient = new HumanClient(`ws://localhost:${port}`, {
      play: true,
      strategy: OUTCOMES.loss,
      beforeOwnMove: async n => {
        if (n !== 4) return;
        // Cut the bot off between its move 3 and our move 4, and wait until
        // the relay has seen it go — so move 4 is buffered, not lost.
        started.sockets[started.sockets.length - 1].terminate();
        await waitFor(() => human.received.some(x => x.type === 'OPPONENT_DISCONNECTED'), 5_000, 'the relay to see the bot go');
      },
    });
    await human.ready();
    human.queue();

    await waitFor(() => human.finished || human.error !== null, 30_000, 'the ninth move');
    expect(human.error).toBeNull();
    await waitFor(() => bot!.getStats().gamesPlayed === 1, 10_000, 'the bot to see the result');
    expect(started.sockets.length, 'it reconnected').toBeGreaterThanOrEqual(2);
    expect(human.received.some(x => x.type === 'OPPONENT_RECONNECTED'), 'by resuming its session').toBe(true);
    expect(bot.getStats()).toMatchObject({ gamesPlayed: 1, losses: 1, abandonedGames: 0, opponentFaults: 0 });
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
    for (let i = 0; i < n; i++) pool.push(startBot(over).bot);
    return pool;
  }

  it('never matches two bots against each other, however long they idle', async () => {
    startPool(3);
    // No human anywhere. Three bots polling a queue that only ever contains
    // other bots must produce no games at all — a bot exists to give a HUMAN an
    // opponent, and two of them playing each other burns ten committed cards.
    await new Promise(r => setTimeout(r, 2_000));

    expect(pool.every(b => b.getStats().state === 'idle' && b.getStats().gamesPlayed === 0)).toBe(true);
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

    // This human never plays, so the bot that took them is still in the game.
    expect(pool.filter(b => b.getStats().state === 'playing')).toHaveLength(1);
    // The extras must not be parked in the queue holding five committed cards.
    expect(pool.filter(b => b.getStats().state === 'queued')).toHaveLength(0);
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
    expect(human.me).toBe(1);

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
    expect(pool.every(b => b.getStats().state !== 'playing' && b.getStats().gamesPlayed === 0)).toBe(true);

    h1.close(); h2.close();
  }, 30_000);
});
