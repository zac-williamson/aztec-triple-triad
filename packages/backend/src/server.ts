import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import {
  GameManager,
  MOVE_INACTIVITY_MS,
  ABANDONMENT_WARN_LEAD_MS,
  MOVES_PER_GAME,
  opponentOf,
  playerNumberIn,
} from './GameManager.js';
import type { ClientMessage, ServerMessage } from './types.js';
import { SESSION_TTL_MS } from './store/GameStore.js';
import type { GameStore } from './store/GameStore.js';
import * as metrics from './metrics.js';
import { MemoryGameStore } from './store/MemoryGameStore.js';
import { RedisGameStore } from './store/RedisGameStore.js';

const DEFAULT_PORT = 5174;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

/**
 * Abuse limits.
 *
 * There is one relay and no horizontal scaling, so a single script opening
 * sockets or spraying messages can make the arena unavailable for everyone.
 * The origin allowlist stops a browser page from doing it; it stops nothing
 * else, because a non-browser client simply sends no Origin header.
 *
 * The message rate is a token bucket rather than a hard per-second cap: real
 * play is bursty — a settlement fans out nine move proofs — and a flat cap
 * would drop legitimate traffic at exactly the wrong moment.
 */
const MAX_CONNECTIONS_PER_IP = Number(process.env.WS_MAX_CONNECTIONS_PER_IP ?? '20');
const MSG_BURST = Number(process.env.WS_MSG_BURST ?? '60');
const MSG_REFILL_PER_SEC = Number(process.env.WS_MSG_REFILL_PER_SEC ?? '20');
const DISCONNECT_TIMEOUT_MS = 60 * 1000; // 60 seconds reconnection window
const SESSION_HANDSHAKE_MS = 2000; // 2 seconds to send RESUME before new session
// How often the present-but-idle abandonment detector runs. Short relative to
// the 60s threshold so the first warning fires promptly at ~60s rather than
// being bound to the 5-minute stale-cleanup loop.
const ABANDONMENT_CHECK_INTERVAL_MS = 5 * 1000; // 5 seconds
// Minimum gap between successive warning broadcasts for the same idle spell, so
// the countdown refreshes without spamming a message every tick.
const ABANDONMENT_WARNING_REFRESH_MS = 10 * 1000; // 10 seconds
// Defense in depth behind the store-level SESSION_TTL_MS: even if a session
// key survives (TTL semantics change, store bug), RESUME refuses anything
// not seen for this long and issues a fresh session instead.
const SESSION_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Known client message types. The relay is a pipe (docs/plan/PRIVATE_GAMES.md
// §6): no lobby, no rules engine, nothing that would show it a card.
const VALID_MESSAGE_TYPES = new Set([
  'TX_CONFIRMED', 'TX_FAILED', 'LEAVE_GAME',
  'KEY_EXCHANGE', 'PEER', 'MOVE',
  'QUEUE_MATCHMAKING', 'CANCEL_MATCHMAKING', 'PING',
  'REGISTER_BOT',
  'RESUME',
]);

// Messages that are buffered to the inbox when recipient is offline
const BUFFERED_MESSAGE_TYPES = new Set([
  'MOVE',
  'OPPONENT_KEY',
  'PEER',
  // So an offline (disconnected-but-recoverable) player still learns on
  // reconnect that they were flagged idle / may forfeit.
  'GAME_ABANDONMENT_WARNING',
]);

/**
 * Size caps for the sealed player-to-player traffic, in base64 characters.
 * An uncompressed P-256 public key is 88 characters and an AES-GCM IV 16; a
 * sealed payload is at most a proof plus a few fields. The caps leave headroom
 * without letting one message fill a player's inbox.
 */
const MAX_PUBLIC_KEY_LENGTH = 256;
const MAX_IV_LENGTH = 64;
const MAX_CIPHERTEXT_LENGTH = 64 * 1024;

/** Standard padded base64 (RFC 4648 §4), which is what `btoa` produces. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A non-empty base64 string of at most `maxLength` characters. */
function isBase64(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && BASE64.test(value);
}

/**
 * Why a sealed payload's `iv` and `ciphertext` are refused, or null if they
 * are fine. PEER and MOVE share the limits. The texts never quote the value.
 */
function sealedPayloadError(msg: { iv?: unknown; ciphertext?: unknown }): string | null {
  if (!isBase64(msg.iv, MAX_IV_LENGTH)) {
    return `iv must be a base64 string of at most ${MAX_IV_LENGTH} characters`;
  }
  if (!isBase64(msg.ciphertext, MAX_CIPHERTEXT_LENGTH)) {
    return `ciphertext must be a base64 string of at most ${MAX_CIPHERTEXT_LENGTH} characters`;
  }
  return null;
}

/** A move number the relay can accept at all: an integer, 0..8. */
function isMoveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MOVES_PER_GAME;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  store?: GameStore;
  /** How long to wait for a RESUME message before creating a new session. Default: 2000ms. */
  sessionHandshakeMs?: number;
  /** Period of the stale games/queue/sessions sweep. Default: 5 minutes. */
  cleanupIntervalMs?: number;
  /** Period of the present-but-idle abandonment detector. Default: 5 seconds. */
  abandonmentCheckIntervalMs?: number;
  /**
   * No-move threshold (ms) — the abandonment DEADLINE. Once the current player
   * has been idle this long the game is claimable. Default: 60s (MOVE_INACTIVITY_MS).
   */
  moveInactivityMs?: number;
  /**
   * How long BEFORE the deadline to start warning both players of impending
   * abandonment (the warning carries a countdown to the deadline). Default: 30s
   * (ABANDONMENT_WARN_LEAD_MS).
   */
  abandonmentWarnLeadMs?: number;
}

export interface CardGameServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  gameManager: GameManager;
  store: GameStore;
  close: () => Promise<void>;
}

/**
 * The commit this process is actually running, read once at startup.
 *
 * Deploying is `git pull` + restart, so the running code and the working tree
 * can silently diverge — and did: the bot was restarted before a fix landed in
 * a module it imports, and the only symptom was a claim failing in production
 * with an error message that had already been deleted from the source. There
 * was no way to see that from outside the box.
 *
 * Best-effort: a checkout without git, or a git that fails, is not a reason to
 * refuse to serve health.
 */
function readDeployedCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}
const DEPLOYED_COMMIT = readDeployedCommit();

export function createServer(options: ServerOptions = {}): CardGameServer {
  // Where the arena bot serves its own health. Same box, localhost only.
  const botHealthPort = Number(process.env.ARENA_BOT_HEALTH_PORT ?? 5175);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  const store = options.store ?? new MemoryGameStore();
  const sessionHandshakeMs = options.sessionHandshakeMs ?? SESSION_HANDSHAKE_MS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
  const abandonmentCheckIntervalMs = options.abandonmentCheckIntervalMs ?? ABANDONMENT_CHECK_INTERVAL_MS;
  const moveInactivityMs = options.moveInactivityMs ?? MOVE_INACTIVITY_MS;
  const warnLeadMs = options.abandonmentWarnLeadMs ?? ABANDONMENT_WARN_LEAD_MS;
  // Start warning this many ms of idleness before the deadline (impending
  // abandonment). Clamped to >= 0 so a lead longer than the deadline just warns
  // from the first detection.
  const warnAfterMs = Math.max(0, moveInactivityMs - warnLeadMs);
  const gameManager = new GameManager(store);

  // playerId → WebSocket (in-memory, rebuilt on reconnect)
  const clients = new Map<string, WebSocket>();
  /** Whether `playerId` has a live socket right now. */
  const isConnected = (playerId: string): boolean => clients.get(playerId)?.readyState === WebSocket.OPEN;
  /**
   * Sessions that have authenticated as the arena bot via REGISTER_BOT. Used to
   * (a) count bot matches in /metrics and (b) DISCLOSE to the human opponent
   * that they are playing a bot. Token-gated so a normal client cannot suppress
   * that disclosure by claiming to be the bot.
   */
  const botPlayerIds = new Set<string>();

  /**
   * Serialises the matchmaking critical section (admission check → queue →
   * match).
   *
   * Node processes another socket message during any `await`, so the handler
   * below is NOT atomic just because the server is single-threaded. Two bots
   * arriving together could each read "no bot has queued yet", both pass the
   * admission check, and both queue — leaving one parked with five committed
   * cards after the other is matched. Observed as a ~1-in-5 flake in the
   * three-bot integration test, which is exactly what a race looks like from
   * the outside.
   */
  let matchmakingLock: Promise<unknown> = Promise.resolve();
  const withMatchmakingLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = matchmakingLock.then(fn, fn);
    // Keep the chain alive when a link rejects, or one failed queue attempt
    // would wedge matchmaking for everyone behind it.
    matchmakingLock = run.catch(() => undefined);
    return run;
  };
  const isBotPlayerId = (id: string): boolean => botPlayerIds.has(id);
  // playerId → disconnect timeout (for reconnection window)
  const disconnectTimeouts = new Map<string, NodeJS.Timeout>();
  // gameId → secondsIdle of the last GAME_ABANDONMENT_WARNING broadcast for the
  // current idle spell. Used to throttle re-warnings and to detect when an idle
  // spell has ended (entry pruned once the game is no longer idle), so a later
  // idle spell warns fresh from the start.
  const lastIdleWarning = new Map<string, number>();

  // Allowed origins for CORS and WebSocket connections.
  // Set ALLOWED_ORIGINS env var to a comma-separated list in production
  // (e.g. "https://play.example.com,https://www.example.com").
  // Localhost defaults are kept so dev doesn't need the env var.
  const envOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(o => o.length > 0);
  const allowedOrigins = new Set<string>([
    'http://localhost:3000',
    'http://localhost:5174',
    ...envOrigins,
  ]);

  const httpServer = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const count = await gameManager.getGameCount();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', games: count }));
      return;
    }

    // Whether the ARENA is playable, visible from outside the box.
    //
    // The bot's own /health is bound to localhost on purpose — it carries
    // counters an operator needs and nothing a stranger should have — but that
    // means the one failure that matters most is invisible off-box: a bot that
    // is up, healthy-looking and unable to play. That state lasted eight hours
    // unnoticed, because the only thing watching it wrote to a file on the same
    // machine.
    //
    // So this republishes the few fields an outside checker needs to answer "is
    // the arena playable?" and nothing else: no addresses, no card ids, no
    // errors that might carry them. Any uptime service can watch it.
    if (req.method === 'GET' && req.url === '/arena-health') {
      // Readable from anywhere, unlike every other route here. A monitoring
      // endpoint that only an allowlisted origin can read cannot be watched
      // from a dashboard, a phone, or a hosted uptime service — which is the
      // entire reason it exists. Safe because the payload is deliberately
      // redacted (see below) and the route is read-only.
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Nothing here is worth a stale second. A dashboard that polls this and
      // gets a cached body reports the past as the present, which is the exact
      // failure this endpoint exists to end.
      res.setHeader('Cache-Control', 'no-store');
      try {
        const upstream = await fetch(`http://127.0.0.1:${botHealthPort}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const bot = await upstream.json() as Record<string, any>;
        const game = bot.game as Record<string, any> | null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          botHealthy: bot.healthy === true,
          botState: bot.state,
          spendableCards: bot.spendableCards,
          cardsStranded: bot.cardsStranded,
          totalFailures: bot.totalFailures,
          // The message can name a game or an address; the fact of it cannot.
          hasError: bot.lastError !== null && bot.lastError !== undefined,
          uptimeMs: bot.uptimeMs,
          // Which commit is actually running here, so "did my fix ship?" is a
          // question the endpoint answers rather than one you SSH in to guess.
          deployedCommit: DEPLOYED_COMMIT,
          // Stamped by the relay, not the reader's clock: a dashboard can only
          // honestly say "12s old" if the server says when it answered.
          generatedAt: Date.now(),
          record: {
            gamesPlayed: bot.gamesPlayed,
            wins: bot.wins,
            losses: bot.losses,
            draws: bot.draws,
            settlements: bot.settlements,
            abandonedGames: bot.abandonedGames,
            cardsUnimported: bot.cardsUnimported,
          },
          // Whole Fee Juice, not wei: it exceeds Number's safe range, and the
          // question this answers is "can it still pay to settle", which does
          // not need the last eighteen digits. A bot that runs out goes quietly
          // idle exactly like one that runs out of cards — the failure this
          // panel exists to catch — and an unsettled game locks ten cards.
          feeJuice: typeof bot.feeJuice === 'string' && /^\d+$/.test(bot.feeJuice)
            ? Number(BigInt(bot.feeJuice) / (10n ** 18n))
            : null,
          failures: {
            join: bot.joinFailures,
            move: bot.moveFailures,
            commit: bot.commitFailures,
            proof: bot.proofFailures,
            settle: bot.settleFailures,
          },
          // The live game, minus the relay session id — that one names a
          // socket, and on-chain ids are public chain state anyone can read.
          game: game === null || game === undefined ? null : {
            onChainGameId: game.onChainGameId,
            playerNumber: game.playerNumber,
            committed: game.committed,
            moveProofs: game.moveProofs,
            handProofs: (game.myHandProof ? 1 : 0) + (game.opponentHandProof ? 1 : 0),
            oweAMove: game.oweAMove,
            opponentGoneFor: game.opponentGoneFor,
            ageSeconds: game.ageSeconds,
            settling: game.settling,
          },
          // Every game still holding our cards, and why each one is not moving.
          journal: Array.isArray(bot.journal) ? bot.journal : [],
          relay: {
            connectedClients: clients.size,
            queueLength: await gameManager.getQueueLength(),
            activeGames: await gameManager.getGameCount(),
          },
        }));
      } catch {
        // The bot being unreachable IS the answer, and a 503 is what an uptime
        // service acts on.
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'bot-unreachable',
          botHealthy: false,
          generatedAt: Date.now(),
          deployedCommit: DEPLOYED_COMMIT,
          relay: {
            connectedClients: clients.size,
            queueLength: await gameManager.getQueueLength(),
            activeGames: await gameManager.getGameCount(),
          },
        }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/queue') {
      // Read-only queue view. The arena bot polls this to learn whether anyone
      // has waited past its join threshold; playerIds are already opaque
      // session ids, so nothing extra is exposed here.
      const snap = await gameManager.queueSnapshot(Date.now(), isBotPlayerId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snap));
      return;
    }

    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...metrics.snapshot(),
        connectedClients: clients.size,
        queueLength: await gameManager.getQueueLength(),
        activeGames: await gameManager.getGameCount(),
      }));
      return;
    }

    // One room, by id, and only what a pipe knows about it: status, move count
    // and who is connected. There is no listing — nothing needs one, and it
    // would hand every room id to anyone who asked.
    if (req.method === 'GET' && req.url?.startsWith('/games/')) {
      const gameId = req.url.slice('/games/'.length);
      const info = await gameManager.roomInfo(gameId, isConnected);
      if (info) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Game not found' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  /** Live connections per remote address, for the per-IP cap. */
  const connectionsPerIp = new Map<string, number>();
  const remoteIp = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }): string => {
    // Behind nginx the socket address is the proxy's, so prefer the forwarded
    // client. Only the FIRST entry is meaningful — the rest are attacker-supplied.
    const fwd = req.headers?.['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0] : undefined;
    return (first?.trim() || req.socket?.remoteAddress || 'unknown');
  };

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      const origin = info.origin;
      // Accept connections with no Origin header (e.g. non-browser clients
      // like tests) OR whose Origin is in the allowed set.
      if (origin && !allowedOrigins.has(origin)) {
        console.warn(`[WS] rejecting connection from disallowed origin: ${origin}`);
        done(false, 403, 'Origin not allowed');
        return;
      }
      // The origin check does nothing for a non-browser client, which sends no
      // Origin at all — so cap concurrent connections per address as well.
      const ip = remoteIp(info.req as never);
      if ((connectionsPerIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
        console.warn(`[WS] rejecting ${ip}: ${MAX_CONNECTIONS_PER_IP} concurrent connections`);
        done(false, 429, 'Too many connections');
        return;
      }
      done(true);
    },
  });

  const QUIET_TYPES = new Set(['PING', 'PONG']);

  /**
   * One line per message, built from an allowlist of fields and never from the
   * message itself. KEY_EXCHANGE, PEER and MOVE carry keys and sealed payloads,
   * so the log gets their type, room and (for a MOVE) its number — the only
   * things the relay reads — and nothing else a client sent.
   */
  function logMsg(direction: 'IN' | 'OUT', playerId: string, msg: { type: string; [k: string]: any }): void {
    if (QUIET_TYPES.has(msg.type)) return;
    const summary: Record<string, any> = { type: msg.type };
    if (typeof msg.gameId === 'string' && msg.gameId) summary.gameId = msg.gameId.slice(0, 12) + '...';
    // Validated before an IN line is written, so this is an integer 0..8.
    if (msg.type === 'MOVE') summary.moveNumber = msg.moveNumber;
    if (direction === 'OUT') {
      if (msg.playerNumber != null) summary.playerNumber = msg.playerNumber;
      if (msg.type === 'ROOM_STATE') summary.movesMade = msg.movesMade;
      if (msg.type === 'ERROR') summary.message = msg.message;
      if (msg.resumed != null) summary.resumed = msg.resumed;
    }
    console.log(`[WS ${direction}] player=${playerId.slice(0, 8)}  ${JSON.stringify(summary)}`);
  }

  function send(ws: WebSocket, msg: ServerMessage, playerId?: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      if (playerId) logMsg('OUT', playerId, msg);
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Send a message to a player. If the player is online, send directly.
   * If offline and the message type is critical, buffer to inbox for replay.
   */
  async function sendToPlayer(playerId: string, msg: ServerMessage): Promise<void> {
    const ws = clients.get(playerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      send(ws, msg, playerId);
    } else if (BUFFERED_MESSAGE_TYPES.has(msg.type)) {
      await store.pushInbox(playerId, msg);
    }
  }

  /** Send `msg` to both members of a room, buffering for whoever is offline. */
  async function sendToRoom(room: { player1Id: string; player2Id: string }, msg: ServerMessage): Promise<void> {
    await sendToPlayer(room.player1Id, msg);
    await sendToPlayer(room.player2Id, msg);
  }

  /**
   * Forward `msg` to the sender's opponent in `gameId`, buffering it in their
   * inbox while they are offline. Only one of the room's two players may send.
   */
  async function forwardToOpponent(ws: WebSocket, playerId: string, gameId: string, msg: ServerMessage): Promise<void> {
    const room = await gameManager.getGame(gameId);
    if (!room) {
      send(ws, { type: 'ERROR', message: 'Game not found' }, playerId);
      return;
    }
    const opponentId = opponentOf(room, playerId);
    if (opponentId === null) {
      send(ws, { type: 'ERROR', message: 'Not in this game' }, playerId);
      return;
    }
    await sendToPlayer(opponentId, msg);
  }

  function validateMessage(msg: any): string | null {
    if (!msg || typeof msg !== 'object' || !msg.type || !VALID_MESSAGE_TYPES.has(msg.type)) {
      return 'Unknown or missing message type';
    }

    switch (msg.type) {
      case 'TX_CONFIRMED':
        // A `txHash` from an older client is ignored: never read, stored or forwarded.
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (msg.txType !== 'create_game' && msg.txType !== 'join_game') return 'txType must be create_game or join_game';
        break;
      case 'TX_FAILED':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (msg.txType !== 'create_game' && msg.txType !== 'join_game') return 'txType must be create_game or join_game';
        if (!msg.error || typeof msg.error !== 'string') return 'error is required';
        break;
      case 'LEAVE_GAME':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        break;
      // The error texts below never quote the offending value: these fields are
      // keys and sealed payloads.
      case 'KEY_EXCHANGE':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (!isBase64(msg.publicKey, MAX_PUBLIC_KEY_LENGTH)) {
          return `publicKey must be a base64 string of at most ${MAX_PUBLIC_KEY_LENGTH} characters`;
        }
        break;
      case 'PEER':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        return sealedPayloadError(msg);
      case 'MOVE':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (!isMoveNumber(msg.moveNumber)) {
          return `moveNumber must be an integer between 0 and ${MOVES_PER_GAME - 1}`;
        }
        return sealedPayloadError(msg);
      case 'REGISTER_BOT':
        if (typeof msg.token !== 'string' || msg.token.length === 0) return 'token is required';
        break;
      case 'RESUME':
        if (!msg.sessionToken || typeof msg.sessionToken !== 'string') return 'sessionToken is required';
        break;
      // QUEUE_MATCHMAKING carries nothing the relay reads. The hand an older
      // client still attaches is not even validated: it is never looked at.
      case 'QUEUE_MATCHMAKING':
      case 'CANCEL_MATCHMAKING':
      case 'PING':
        break;
    }
    return null;
  }

  /** Create and register a brand-new session for this socket. */
  async function createFreshSession(ws: WebSocket, reason: string): Promise<string> {
    const playerId = uuidv4();
    const sessionToken = uuidv4();
    const now = Date.now();
    await store.setSession(sessionToken, { playerId, createdAt: now, lastSeen: now });
    await store.setSessionTokenByPlayer(playerId, sessionToken);
    clients.set(playerId, ws);
    send(ws, { type: 'SESSION_ESTABLISHED', sessionToken, playerId, resumed: false, gameId: null }, playerId);
    console.log(`[WS] player=${playerId.slice(0, 8)} new session (${reason})`);
    return playerId;
  }

  /**
   * Refresh a connected player's session so it cannot expire mid-connection:
   * bumps lastSeen and slides both the session and reverse-mapping TTLs.
   */
  async function touchSession(playerId: string): Promise<void> {
    const token = await store.getSessionTokenByPlayer(playerId);
    if (!token) return;
    const session = await store.getSession(token);
    if (!session) return;
    session.lastSeen = Date.now();
    await store.setSession(token, session);
    await store.setSessionTokenByPlayer(playerId, token);
  }

  /**
   * Establish a session for a new or resumed connection.
   * Returns the playerId associated with this socket.
   */
  async function establishSession(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(async () => {
        if (resolved) return;
        resolved = true;
        // No RESUME received — create new session
        resolve(await createFreshSession(ws, 'no resume'));
      }, sessionHandshakeMs);

      // Listen for a RESUME message as the first message
      const onMessage = async (data: Buffer | string) => {
        if (resolved) return;
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // Ignore malformed, wait for timeout
        }

        if (msg.type === 'RESUME' && msg.sessionToken) {
          resolved = true;
          clearTimeout(timeout);
          ws.removeListener('message', onMessage);

          const session = await store.getSession(msg.sessionToken);
          const idleMs = session ? Date.now() - session.lastSeen : 0;
          if (session && idleMs > SESSION_STALE_MS) {
            // Session survived in the store but has not been seen for too
            // long to trust (server crash, clients-map gap). Discard it and
            // start over rather than resume into inconsistent state.
            await store.deleteSession(msg.sessionToken);
            await store.deleteSessionTokenByPlayer(session.playerId);
            console.log(
              `[WS] player=${session.playerId.slice(0, 8)} rejected stale session ` +
              `(last seen ${Math.round(idleMs / 3_600_000)}h ago, limit ${SESSION_STALE_MS / 3_600_000}h)`,
            );
            resolve(await createFreshSession(ws, 'stale token'));
          } else if (session) {
            const playerId = session.playerId;
            session.lastSeen = Date.now();
            await store.setSession(msg.sessionToken, session);
            // Slide the reverse-mapping TTL in step with the session's
            await store.setSessionTokenByPlayer(playerId, msg.sessionToken);
            clients.set(playerId, ws);

            // Cancel any pending disconnect timeout
            const disconnectTimeout = disconnectTimeouts.get(playerId);
            if (disconnectTimeout) {
              clearTimeout(disconnectTimeout);
              disconnectTimeouts.delete(playerId);
            }

            // Find active game for this player. Use getValidPlayerGame so that
            // a stale player→game mapping pointing to a deleted game is cleaned
            // up here instead of causing "already in a game" errors later.
            const validRoom = await gameManager.getValidPlayerGame(playerId);
            const gameId = validRoom?.id ?? null;

            send(ws, { type: 'SESSION_ESTABLISHED', sessionToken: msg.sessionToken, playerId, resumed: true, gameId }, playerId);
            console.log(`[WS] player=${playerId.slice(0, 8)} resumed session${gameId ? ` (game ${gameId.slice(0, 12)}...)` : ''}`);

            // Replay buffered inbox messages
            const inbox = await store.getInbox(playerId);
            if (inbox.length > 0) {
              console.log(`[WS] replaying ${inbox.length} buffered message(s) to player=${playerId.slice(0, 8)}`);
              for (const buffered of inbox) {
                send(ws, buffered as ServerMessage, playerId);
              }
              await store.clearInbox(playerId);
            }

            // Then where the room stands. After the inbox, so the client can
            // rebuild its board from its own transcript plus the replayed
            // moves and check the count against `movesMade`. Read afresh:
            // the replay awaited the store, and a move may have landed since.
            const room = gameId ? await gameManager.getGame(gameId) : null;
            const playerNumber = room ? playerNumberIn(room, playerId) : null;
            if (room && playerNumber !== null) {
              const opponentId = playerNumber === 1 ? room.player2Id : room.player1Id;
              send(ws, {
                type: 'ROOM_STATE',
                gameId: room.id,
                playerNumber,
                movesMade: room.movesMade,
                opponentConnected: isConnected(opponentId),
              }, playerId);
              await sendToPlayer(opponentId, { type: 'OPPONENT_RECONNECTED', gameId: room.id });
            }

            resolve(playerId);
          } else {
            // Expired/invalid session — create new
            resolve(await createFreshSession(ws, 'expired token'));
          }
        }
        // If first message is not RESUME, let the timeout handle it
      };

      ws.on('message', onMessage);

      // Clean up the RESUME listener once resolved
      const checkCleanup = () => {
        if (resolved) {
          ws.removeListener('message', onMessage);
        } else {
          setTimeout(checkCleanup, 100);
        }
      };
      setTimeout(checkCleanup, sessionHandshakeMs + 100);
    });
  }

  wss.on('connection', async (ws: WebSocket, req?: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
    const ip = req ? remoteIp(req) : 'unknown';
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);

    // Token bucket, per connection. Starts full so a client that opens and
    // immediately submits a queued game is never punished for it.
    let tokens = MSG_BURST;
    let lastRefill = Date.now();

    const playerId = await establishSession(ws);

    async function processMessage(rawData: string): Promise<void> {
      let msg: any;
      try {
        msg = JSON.parse(rawData);
      } catch {
        send(ws, { type: 'ERROR', message: 'Invalid message format' }, playerId);
        return;
      }

      // Skip RESUME messages after session is established
      if (msg.type === 'RESUME') return;

      const validationError = validateMessage(msg);
      if (validationError) {
        send(ws, { type: 'ERROR', message: validationError }, playerId);
        return;
      }

      logMsg('IN', playerId, msg);
      await handleMessage(playerId, ws, msg as ClientMessage);
    }

    /**
     * One sender's messages are handled in the order they arrived. Handlers
     * await the store, and a MOVE also waits for its room's lock, so two
     * messages sent back to back would otherwise race: a PEER sent just after
     * a MOVE could reach the opponent first. A pipe keeps its order.
     */
    let inOrder: Promise<void> = Promise.resolve();

    ws.on('message', (data: Buffer | string) => {
      // Rate and size are judged on arrival, not when the message's turn comes:
      // a flooding client is closed at once rather than queued.
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - lastRefill) / 1000) * MSG_REFILL_PER_SEC);
      lastRefill = now;
      if (tokens < 1) {
        // Closing rather than replying: an ERROR to a flooding client is just
        // more traffic, and a well-behaved one never reaches this.
        console.warn(`[WS] closing ${playerId} from ${ip}: message rate exceeded`);
        ws.close(1008, 'Message rate exceeded');
        return;
      }
      tokens -= 1;

      const rawData = data.toString();
      if (rawData.length > MAX_MESSAGE_SIZE) {
        send(ws, { type: 'ERROR', message: 'Message too large (max 1MB)' }, playerId);
        return;
      }

      inOrder = inOrder
        .then(() => processMessage(rawData))
        // Keep the chain alive: one failed handler must not wedge the socket.
        .catch((err: unknown) => {
          console.error(`[WS] player=${playerId.slice(0, 8)} message handler failed: ${(err as Error)?.message ?? err}`);
        });
    });

    ws.on('close', () => {
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsPerIp.set(ip, left); else connectionsPerIp.delete(ip);
      handleDisconnect(playerId);
    });

    ws.on('error', () => {
      handleDisconnect(playerId);
    });
  });

  /** Report a commit's outcome to both players. */
  async function reportTxStatus(ws: WebSocket, playerId: string, gameId: string, txStatus: 'confirmed' | 'failed'): Promise<void> {
    try {
      const status = await gameManager.updateTxStatus(gameId, playerId, txStatus);
      const room = status ? await gameManager.getGame(gameId) : null;
      if (!status || !room) {
        send(ws, { type: 'ERROR', message: 'Game not found or player not in game' }, playerId);
        return;
      }
      await sendToRoom(room, { type: 'ON_CHAIN_STATUS', gameId, status });
    } catch (err: any) {
      send(ws, { type: 'ERROR', message: err.message }, playerId);
    }
  }

  async function handleMessage(playerId: string, ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      // A move the relay cannot read. It checks the number and whose turn it
      // is — all it can see — and forwards the rest untouched. Whether the
      // move is legal is the opponent's to check, against its proof.
      case 'MOVE': {
        try {
          const { room, opponentId, movesComplete } = await gameManager.recordMove(msg.gameId, playerId, msg.moveNumber);
          // Rebuilt from its validated fields, so nothing else a client
          // attaches rides along to the opponent.
          await sendToPlayer(opponentId, {
            type: 'MOVE',
            gameId: msg.gameId,
            moveNumber: msg.moveNumber,
            iv: msg.iv,
            ciphertext: msg.ciphertext,
          });
          if (movesComplete) {
            metrics.increment('gamesCompleted');
            // The ninth move is what makes a game settleable once both records
            // are on-chain; say so the moment it does, or `canSettle` would
            // only ever show up on some later tx report.
            if (room.onChainStatus.canSettle) {
              await sendToRoom(room, { type: 'ON_CHAIN_STATUS', gameId: room.id, status: room.onChainStatus });
            }
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'TX_CONFIRMED':
        await reportTxStatus(ws, playerId, msg.gameId, 'confirmed');
        break;

      case 'TX_FAILED':
        await reportTxStatus(ws, playerId, msg.gameId, 'failed');
        break;

      case 'LEAVE_GAME': {
        // Only the sender is released; the room stays, because the other player
        // may still be talking through it. Without this a player who walks away
        // from an abandoned game stays bound to it until the stale-game sweep,
        // and every queue attempt in between is rejected.
        await gameManager.releasePlayer(playerId);
        break;
      }

      // KEY_EXCHANGE and PEER are forwarded and nothing more. The relay must
      // never hold the game key or read a payload, so it does not look inside
      // either. Each is rebuilt from its validated fields, so nothing else a
      // client attaches rides along to the opponent.
      case 'KEY_EXCHANGE': {
        try {
          await forwardToOpponent(ws, playerId, msg.gameId, {
            type: 'OPPONENT_KEY',
            gameId: msg.gameId,
            publicKey: msg.publicKey,
          });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'PEER': {
        try {
          await forwardToOpponent(ws, playerId, msg.gameId, {
            type: 'PEER',
            gameId: msg.gameId,
            iv: msg.iv,
            ciphertext: msg.ciphertext,
          });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'REGISTER_BOT': {
        const expected = process.env.ARENA_BOT_TOKEN;
        if (!expected) {
          send(ws, { type: 'ERROR', message: 'Bot registration is not enabled' }, playerId);
          break;
        }
        if (msg.token !== expected) {
          send(ws, { type: 'ERROR', message: 'Bot registration refused' }, playerId);
          break;
        }
        botPlayerIds.add(playerId);
        send(ws, { type: 'BOT_REGISTERED' }, playerId);
        break;
      }

      case 'QUEUE_MATCHMAKING': {
        await withMatchmakingLock(async () => {
        try {
          // A bot decides to offer by POLLING /queue, so N bots read the same
          // state before any of their queue messages arrive and all of them
          // offer for one waiting player. The extras then sit in the queue
          // until they time out. The bot-side check cannot close that window —
          // only the server sees the queue at the moment of the decision, and
          // it is single-threaded, so this is where the rule has to be enforced.
          //
          // Declined, not an ERROR: standing down is correct behaviour, and
          // routing it through the error path would inflate the bot's failure
          // counters and make a healthy pool look broken.
          if (isBotPlayerId(playerId)) {
            const snap = await gameManager.queueSnapshot(Date.now(), isBotPlayerId);
            if (snap.botsQueued >= snap.humansWaiting) {
              // Two different situations, and conflating them makes the logs
              // lie: a bot that arrives just after the waiting player was
              // matched is told "0 bots already cover 0 players", which reads
              // like a bug rather than the ordinary end of a race.
              send(ws, {
                type: 'QUEUE_DECLINED',
                reason: snap.humansWaiting === 0 ? 'nobody-waiting' : 'already-covered',
                humansWaiting: snap.humansWaiting,
                botsQueued: snap.botsQueued,
              }, playerId);
              return;   // inside the lock callback — `break` cannot cross it
            }
          }
          const position = await gameManager.queuePlayer(playerId);
          send(ws, { type: 'MATCHMAKING_QUEUED', position }, playerId);

          const match = await gameManager.tryMatch(new Set(clients.keys()), isBotPlayerId);
          if (match) {
            const { entry1, entry2, room } = match;
            // Match metrics: wait time per side, and whether the arena bot was
            // one of them (its playerId is tagged at queue time).
            const matchedAt = Date.now();
            metrics.increment('matchesFormed');
            metrics.increment('gamesCreated');
            for (const e of [entry1, entry2]) metrics.recordMatchWait(matchedAt - e.queuedAt);
            if (isBotPlayerId(entry1.playerId) || isBotPlayerId(entry2.playerId)) {
              metrics.increment('botMatchesFormed');
            }
            // A room and a seat, nothing more: there is no game state to send,
            // because the relay has none. Deliberately says nothing about who
            // the opponent is either. The bot is a fallback for when nobody
            // else is queuing, and a player meeting one should not be able to
            // tell — not from the UI, and not by reading this frame in devtools.
            await sendToPlayer(entry1.playerId, { type: 'MATCH_FOUND', gameId: room.id, playerNumber: 1 });
            await sendToPlayer(entry2.playerId, { type: 'MATCH_FOUND', gameId: room.id, playerNumber: 2 });
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        });
        break;
      }

      case 'CANCEL_MATCHMAKING': {
        await gameManager.dequeuePlayer(playerId);
        send(ws, { type: 'MATCHMAKING_CANCELLED' }, playerId);
        break;
      }

      case 'PING': {
        await gameManager.updatePing(playerId);
        await touchSession(playerId);
        send(ws, { type: 'PONG' }, playerId);
        break;
      }

      // RESUME is handled during session establishment, skip here
      case 'RESUME':
        break;
    }
  }

  async function handleDisconnect(playerId: string): Promise<void> {
    console.log(`[WS] player=${playerId.slice(0, 8)} disconnected`);
    clients.delete(playerId);
    botPlayerIds.delete(playerId);

    await gameManager.dequeuePlayer(playerId);

    const room = await gameManager.getValidPlayerGame(playerId);
    const opponentId = room ? opponentOf(room, playerId) : null;
    if (room && opponentId !== null) {
      await sendToPlayer(opponentId, { type: 'OPPONENT_DISCONNECTED', gameId: room.id });

      // Set a reconnection window timeout
      const timeout = setTimeout(async () => {
        disconnectTimeouts.delete(playerId);
        // Don't remove the room — keep it for abandoned game recovery.
        // The stale game cleanup timer handles eventual removal.
      }, DISCONNECT_TIMEOUT_MS);
      disconnectTimeouts.set(playerId, timeout);
    }
  }

  /**
   * Present-but-idle abandonment detector. Finds every game being played whose
   * current player — by the relay's move count — has not moved for long enough
   * and warns BOTH players with GAME_ABANDONMENT_WARNING. The warning is
   * refreshed (re-sent with a larger secondsIdle) at most once per
   * ABANDONMENT_WARNING_REFRESH_MS so the countdown advances without spamming.
   * The per-game tracker is pruned once a game is no longer idle (a move arrived
   * or all nine are in) so the next idle spell warns from the start.
   */
  async function checkAbandonment(): Promise<void> {
    const idleGames = await gameManager.findIdleGames(warnAfterMs);
    const idleIds = new Set(idleGames.map(g => g.gameId));

    // Prune trackers for games that are no longer idle (moved, ended, removed).
    for (const gameId of lastIdleWarning.keys()) {
      if (!idleIds.has(gameId)) lastIdleWarning.delete(gameId);
    }

    const deadlineSeconds = Math.ceil(moveInactivityMs / 1000);
    for (const game of idleGames) {
      const prev = lastIdleWarning.get(game.gameId);
      // Warn on first detection, then only after the refresh interval elapses.
      if (prev !== undefined && game.secondsIdle - prev < ABANDONMENT_WARNING_REFRESH_MS / 1000) {
        continue;
      }
      lastIdleWarning.set(game.gameId, game.secondsIdle);
      // Live countdown to the deadline: > 0 while abandonment is impending, 0
      // once the game is claimable. Both UIs tick it locally between re-sends.
      const secondsUntilClaimable = Math.max(0, deadlineSeconds - game.secondsIdle);
      const warning: ServerMessage = {
        type: 'GAME_ABANDONMENT_WARNING',
        gameId: game.gameId,
        idlePlayer: game.idlePlayer,
        secondsIdle: game.secondsIdle,
        secondsUntilClaimable,
      };
      await sendToPlayer(game.player1Id, warning);
      await sendToPlayer(game.player2Id, warning);
    }
  }

  const abandonmentInterval = setInterval(() => {
    void checkAbandonment();
  }, abandonmentCheckIntervalMs);

  const cleanupInterval = setInterval(async () => {
    await gameManager.cleanupStaleGames();
    await gameManager.cleanupStaleQueue();
    // Sessions are server-owned (GameManager never touches them), so the
    // sweep goes straight to the store. Threshold = the store TTL, giving
    // MemoryGameStore active expiry on top of its lazy on-read expiry.
    await store.cleanupStaleSessions(SESSION_TTL_MS);
  }, cleanupIntervalMs);

  async function close(): Promise<void> {
    clearInterval(cleanupInterval);
    clearInterval(abandonmentInterval);
    lastIdleWarning.clear();
    for (const timeout of disconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    disconnectTimeouts.clear();
    for (const ws of clients.values()) {
      ws.close();
    }
    clients.clear();
    await store.close();
    return new Promise((resolve, reject) => {
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  return { httpServer, wss, gameManager, store, close };
}

// Start the server if run directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const port = parseInt(process.env.WS_PORT ?? String(DEFAULT_PORT), 10);
  const redisUrl = process.env.REDIS_URL;

  (async () => {
    let store: GameStore | undefined;
    if (redisUrl) {
      const redis = new RedisGameStore(redisUrl);
      await redis.connect();
      store = redis;
      console.log(`Using Redis store at ${redisUrl}`);
    }

    const server = createServer({ port, store });
    server.httpServer.listen(port, () => {
      console.log(`Axolotl Arena server running on port ${port}${store ? ' (Redis)' : ' (in-memory)'}`);
    });
  })();
}
