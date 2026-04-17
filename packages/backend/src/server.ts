import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { GameManager } from './GameManager.js';
import type { ClientMessage, ServerMessage } from './types.js';
import type { GameState } from '@axolotl-arena/game-logic';
import type { GameStore } from './store/GameStore.js';
import { MemoryGameStore } from './store/MemoryGameStore.js';
import { RedisGameStore } from './store/RedisGameStore.js';

const DEFAULT_PORT = 5174;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const DISCONNECT_TIMEOUT_MS = 60 * 1000; // 60 seconds reconnection window
const SESSION_HANDSHAKE_MS = 2000; // 2 seconds to send RESUME before new session

// Known client message types
const VALID_MESSAGE_TYPES = new Set([
  'CREATE_GAME', 'JOIN_GAME', 'PLACE_CARD', 'LIST_GAMES', 'GET_GAME',
  'SUBMIT_HAND_PROOF', 'SUBMIT_MOVE_PROOF',
  'TX_CONFIRMED', 'TX_FAILED', 'CANCEL_GAME',
  'SHARE_AZTEC_INFO',
  'RELAY_NOTE_DATA',
  'SETTLE_STARTED',
  'QUEUE_MATCHMAKING', 'CANCEL_MATCHMAKING', 'PING',
  'RESUME',
]);

// Messages that are buffered to the inbox when recipient is offline
const BUFFERED_MESSAGE_TYPES = new Set([
  'HAND_PROOF',
  'MOVE_PROVEN',
  'OPPONENT_AZTEC_INFO',
  'NOTE_DATA',
  'OPPONENT_SETTLING',
]);

export interface ServerOptions {
  port?: number;
  host?: string;
  store?: GameStore;
  /** How long to wait for a RESUME message before creating a new session. Default: 2000ms. */
  sessionHandshakeMs?: number;
}

export interface CardGameServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  gameManager: GameManager;
  store: GameStore;
  close: () => Promise<void>;
}

export function createServer(options: ServerOptions = {}): CardGameServer {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  const store = options.store ?? new MemoryGameStore();
  const sessionHandshakeMs = options.sessionHandshakeMs ?? SESSION_HANDSHAKE_MS;
  const gameManager = new GameManager(store);

  // playerId → WebSocket (in-memory, rebuilt on reconnect)
  const clients = new Map<string, WebSocket>();
  // playerId → disconnect timeout (for reconnection window)
  const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

    if (req.method === 'GET' && req.url === '/games') {
      const list = await gameManager.listGames();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/games/')) {
      const gameId = req.url.slice('/games/'.length);
      const room = await gameManager.getGame(gameId);
      if (room) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: room.id,
          status: room.state?.status ?? 'waiting',
          player1Connected: clients.has(room.player1Id),
          player2Connected: room.player2Id ? clients.has(room.player2Id) : false,
          currentTurn: room.state?.currentTurn,
          winner: room.state?.winner,
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Game not found' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      const origin = info.origin;
      // Accept connections with no Origin header (e.g. non-browser clients
      // like tests) OR whose Origin is in the allowed set.
      if (!origin || allowedOrigins.has(origin)) {
        done(true);
      } else {
        console.warn(`[WS] rejecting connection from disallowed origin: ${origin}`);
        done(false, 403, 'Origin not allowed');
      }
    },
  });

  const QUIET_TYPES = new Set(['PING', 'PONG']);

  function logMsg(direction: 'IN' | 'OUT', playerId: string, msg: { type: string; [k: string]: any }): void {
    if (QUIET_TYPES.has(msg.type)) return;
    const summary: Record<string, any> = { type: msg.type };
    if (msg.gameId) summary.gameId = (msg.gameId as string).slice(0, 12) + '...';
    if (msg.playerNumber != null) summary.playerNumber = msg.playerNumber;
    if (msg.winner != null) summary.winner = msg.winner;
    if (msg.message) summary.message = msg.message;
    if (msg.resumed != null) summary.resumed = msg.resumed;
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

  async function getOpponentId(gameId: string, playerId: string): Promise<string | null> {
    const room = await gameManager.getGame(gameId);
    if (!room) return null;
    if (room.player1Id === playerId) return room.player2Id;
    if (room.player2Id === playerId) return room.player1Id;
    return null;
  }

  function sanitizeGameStateForPlayer(state: GameState, playerId: string, room: { player1Id: string }): GameState {
    const isPlayer1 = playerId === room.player1Id;

    if (state.status === 'playing') {
      const sanitized = { ...state };
      const hiddenCard = { id: 0, name: 'Hidden', ranks: { top: 0, right: 0, bottom: 0, left: 0 } };
      const HIDDEN_COUNT = 2;
      if (isPlayer1) {
        sanitized.player2Hand = state.player2Hand.map((card, i) => i >= state.player2Hand.length - HIDDEN_COUNT ? { ...hiddenCard } : card);
      } else {
        sanitized.player1Hand = state.player1Hand.map((card, i) => i >= state.player1Hand.length - HIDDEN_COUNT ? { ...hiddenCard } : card);
      }
      return sanitized;
    }
    return state;
  }

  function validateMessage(msg: any): string | null {
    if (!msg || typeof msg !== 'object' || !msg.type || !VALID_MESSAGE_TYPES.has(msg.type)) {
      return 'Unknown or missing message type';
    }

    switch (msg.type) {
      case 'CREATE_GAME':
        if (!Array.isArray(msg.cardIds)) return 'cardIds must be an array of numbers';
        if (!msg.cardIds.every((id: any) => typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 256)) {
          return 'cardIds must contain integers between 1 and 256';
        }
        break;
      case 'JOIN_GAME':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required and must be a string';
        if (!Array.isArray(msg.cardIds)) return 'cardIds must be an array of numbers';
        if (!msg.cardIds.every((id: any) => typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 256)) {
          return 'cardIds must contain integers between 1 and 256';
        }
        break;
      case 'PLACE_CARD':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (typeof msg.handIndex !== 'number' || !Number.isInteger(msg.handIndex) || msg.handIndex < 0 || msg.handIndex > 4) {
          return 'handIndex must be an integer between 0 and 4';
        }
        if (typeof msg.row !== 'number' || !Number.isInteger(msg.row) || msg.row < 0 || msg.row > 2) {
          return 'row must be an integer between 0 and 2';
        }
        if (typeof msg.col !== 'number' || !Number.isInteger(msg.col) || msg.col < 0 || msg.col > 2) {
          return 'col must be an integer between 0 and 2';
        }
        if (typeof msg.moveNumber !== 'number' || !Number.isInteger(msg.moveNumber) || msg.moveNumber < 0 || msg.moveNumber > 8) {
          return 'moveNumber must be an integer between 0 and 8';
        }
        break;
      case 'GET_GAME':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        break;
      case 'SUBMIT_HAND_PROOF':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (!msg.handProof || typeof msg.handProof !== 'object') return 'handProof is required';
        break;
      case 'SUBMIT_MOVE_PROOF':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (typeof msg.handIndex !== 'number') return 'handIndex must be a number';
        if (typeof msg.row !== 'number' || msg.row < 0 || msg.row > 2) return 'row must be 0-2';
        if (typeof msg.col !== 'number' || msg.col < 0 || msg.col > 2) return 'col must be 0-2';
        if (typeof msg.moveNumber !== 'number' || !Number.isInteger(msg.moveNumber) || msg.moveNumber < 0 || msg.moveNumber > 8) {
          return 'moveNumber must be an integer between 0 and 8';
        }
        if (!msg.moveProof || typeof msg.moveProof !== 'object') return 'moveProof is required';
        break;
      case 'TX_CONFIRMED':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (msg.txType !== 'create_game' && msg.txType !== 'join_game') return 'txType must be create_game or join_game';
        if (!msg.txHash || typeof msg.txHash !== 'string') return 'txHash is required';
        break;
      case 'TX_FAILED':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (msg.txType !== 'create_game' && msg.txType !== 'join_game') return 'txType must be create_game or join_game';
        if (!msg.error || typeof msg.error !== 'string') return 'error is required';
        break;
      case 'CANCEL_GAME':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        break;
      case 'SHARE_AZTEC_INFO':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (!msg.aztecAddress || typeof msg.aztecAddress !== 'string') return 'aztecAddress is required';
        break;
      case 'RELAY_NOTE_DATA':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (!msg.txHash || typeof msg.txHash !== 'string') return 'txHash is required';
        if (!Array.isArray(msg.notes)) return 'notes must be an array';
        break;
      case 'SETTLE_STARTED':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required';
        if (typeof msg.selectedCardId !== 'number') return 'selectedCardId must be a number';
        break;
      case 'QUEUE_MATCHMAKING':
        if (!Array.isArray(msg.cardIds)) return 'cardIds must be an array of numbers';
        if (!msg.cardIds.every((id: any) => typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 256)) {
          return 'cardIds must contain integers between 1 and 256';
        }
        break;
      case 'RESUME':
        if (!msg.sessionToken || typeof msg.sessionToken !== 'string') return 'sessionToken is required';
        break;
      case 'CANCEL_MATCHMAKING':
      case 'PING':
        break;
    }
    return null;
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
        const playerId = uuidv4();
        const sessionToken = uuidv4();
        const now = Date.now();
        await store.setSession(sessionToken, { playerId, createdAt: now, lastSeen: now });
        await store.setSessionTokenByPlayer(playerId, sessionToken);
        clients.set(playerId, ws);
        send(ws, { type: 'SESSION_ESTABLISHED', sessionToken, playerId, resumed: false, gameId: null }, playerId);
        console.log(`[WS] player=${playerId.slice(0, 8)} new session`);
        resolve(playerId);
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
          if (session) {
            const playerId = session.playerId;
            session.lastSeen = Date.now();
            await store.setSession(msg.sessionToken, session);
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

            // If in active game, send current game state and notify opponent
            if (gameId) {
              const room = await gameManager.getGame(gameId);
              if (room && room.state) {
                const playerRole = await gameManager.getPlayerRole(gameId, playerId);
                if (playerRole) {
                  const playerNum = playerRole === 'player1' ? 1 : 2;
                  send(ws, {
                    type: 'GAME_STATE',
                    gameId,
                    gameState: sanitizeGameStateForPlayer(room.state, playerId, room),
                    captures: [],
                  }, playerId);
                  // Also send playerNumber and gameId context
                  send(ws, {
                    type: room.state.status === 'finished'
                      ? 'GAME_OVER'
                      : (playerNum === 1 ? 'GAME_START' : 'GAME_JOINED'),
                    gameId,
                    ...(room.state.status === 'finished'
                      ? { gameState: room.state, winner: room.state.winner!, player1CardIds: room.player1CardIds, player2CardIds: room.player2CardIds }
                      : { gameState: sanitizeGameStateForPlayer(room.state, playerId, room), playerNumber: playerNum }),
                  } as ServerMessage, playerId);
                }

                // Notify opponent of reconnection
                const opponentId = await getOpponentId(gameId, playerId);
                if (opponentId) {
                  await sendToPlayer(opponentId, { type: 'OPPONENT_RECONNECTED', gameId });
                }
              }
            }

            resolve(playerId);
          } else {
            // Expired/invalid session — create new
            const playerId = uuidv4();
            const sessionToken = uuidv4();
            const now = Date.now();
            await store.setSession(sessionToken, { playerId, createdAt: now, lastSeen: now });
            await store.setSessionTokenByPlayer(playerId, sessionToken);
            clients.set(playerId, ws);
            send(ws, { type: 'SESSION_ESTABLISHED', sessionToken, playerId, resumed: false, gameId: null }, playerId);
            console.log(`[WS] player=${playerId.slice(0, 8)} new session (expired token)`);
            resolve(playerId);
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

  wss.on('connection', async (ws: WebSocket) => {
    const playerId = await establishSession(ws);

    ws.on('message', async (data: Buffer | string) => {
      const rawData = data.toString();
      if (rawData.length > MAX_MESSAGE_SIZE) {
        send(ws, { type: 'ERROR', message: 'Message too large (max 1MB)' }, playerId);
        return;
      }

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
    });

    ws.on('close', () => {
      handleDisconnect(playerId);
    });

    ws.on('error', () => {
      handleDisconnect(playerId);
    });
  });

  async function handleMessage(playerId: string, ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'CREATE_GAME': {
        try {
          const room = await gameManager.createGame(playerId, msg.cardIds);
          send(ws, { type: 'GAME_CREATED', gameId: room.id, playerNumber: 1 }, playerId);
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'JOIN_GAME': {
        try {
          const room = await gameManager.joinGame(msg.gameId, playerId, msg.cardIds);
          send(ws, {
            type: 'GAME_JOINED',
            gameId: room.id,
            playerNumber: 2,
            gameState: sanitizeGameStateForPlayer(room.state, playerId, room),
          }, playerId);
          await sendToPlayer(room.player1Id, {
            type: 'GAME_START',
            gameId: room.id,
            gameState: sanitizeGameStateForPlayer(room.state, room.player1Id, room),
          });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'PLACE_CARD': {
        try {
          const result = await gameManager.placeCard(msg.gameId, playerId, msg.handIndex, msg.row, msg.col, msg.moveNumber);
          const room = await gameManager.getGame(msg.gameId);

          send(ws, {
            type: 'GAME_STATE',
            gameId: msg.gameId,
            gameState: room ? sanitizeGameStateForPlayer(result.newState, playerId, room) : result.newState,
            captures: result.captures,
          }, playerId);

          const opponentId = await getOpponentId(msg.gameId, playerId);
          if (opponentId && room) {
            await sendToPlayer(opponentId, {
              type: 'GAME_STATE',
              gameId: msg.gameId,
              gameState: sanitizeGameStateForPlayer(result.newState, opponentId, room),
              captures: result.captures,
            });
          }

          if (result.newState.status === 'finished') {
            const overMsg: ServerMessage = {
              type: 'GAME_OVER',
              gameId: msg.gameId,
              gameState: result.newState,
              winner: result.newState.winner!,
              player1CardIds: room?.player1CardIds ?? [],
              player2CardIds: room?.player2CardIds ?? [],
            };
            send(ws, overMsg, playerId);
            if (opponentId) await sendToPlayer(opponentId, overMsg);
            await gameManager.releasePlayersFromGame(msg.gameId);
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'LIST_GAMES': {
        const list = await gameManager.listGames();
        send(ws, { type: 'GAME_LIST', games: list }, playerId);
        break;
      }

      case 'GET_GAME': {
        const room = await gameManager.getGame(msg.gameId);
        if (room) {
          send(ws, {
            type: 'GAME_INFO',
            game: {
              id: room.id,
              status: (room.state?.status ?? 'waiting') as 'waiting' | 'playing' | 'finished',
              player1Connected: clients.has(room.player1Id),
              player2Connected: room.player2Id ? clients.has(room.player2Id) : false,
              currentTurn: room.state?.currentTurn,
              winner: room.state?.winner,
            },
          }, playerId);
        } else {
          send(ws, { type: 'GAME_INFO', game: null }, playerId);
        }
        break;
      }

      case 'SUBMIT_HAND_PROOF': {
        try {
          const room = await gameManager.getGame(msg.gameId);
          if (!room) {
            send(ws, { type: 'ERROR', message: 'Game not found' }, playerId);
            break;
          }
          const playerRole = await gameManager.getPlayerRole(msg.gameId, playerId);
          if (!playerRole) {
            send(ws, { type: 'ERROR', message: 'Not in this game' }, playerId);
            break;
          }
          const fromPlayer = playerRole === 'player1' ? 1 : 2;
          const opponentId = await getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            await sendToPlayer(opponentId, {
              type: 'HAND_PROOF',
              gameId: msg.gameId,
              handProof: msg.handProof,
              fromPlayer: fromPlayer as 1 | 2,
            });
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'SUBMIT_MOVE_PROOF': {
        try {
          const room = await gameManager.getGame(msg.gameId);
          if (!room || !room.state) {
            send(ws, { type: 'ERROR', message: 'Game not found' }, playerId);
            break;
          }

          const opponentId = await getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            await sendToPlayer(opponentId, {
              type: 'MOVE_PROVEN',
              gameId: msg.gameId,
              gameState: sanitizeGameStateForPlayer(room.state, opponentId, room),
              captures: [],
              moveProof: msg.moveProof,
              handIndex: msg.handIndex,
              row: msg.row,
              col: msg.col,
            });
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'TX_CONFIRMED': {
        const status = await gameManager.updateTxStatus(msg.gameId, playerId, 'confirmed');
        if (status) {
          const room = await gameManager.getGame(msg.gameId);
          if (room) {
            const statusMsg: ServerMessage = { type: 'ON_CHAIN_STATUS', gameId: msg.gameId, status };
            await sendToPlayer(room.player1Id, statusMsg);
            if (room.player2Id) await sendToPlayer(room.player2Id, statusMsg);
          }
        } else {
          send(ws, { type: 'ERROR', message: 'Game not found or player not in game' }, playerId);
        }
        break;
      }

      case 'TX_FAILED': {
        const status = await gameManager.updateTxStatus(msg.gameId, playerId, 'failed');
        if (status) {
          const room = await gameManager.getGame(msg.gameId);
          if (room) {
            const statusMsg: ServerMessage = { type: 'ON_CHAIN_STATUS', gameId: msg.gameId, status };
            await sendToPlayer(room.player1Id, statusMsg);
            if (room.player2Id) await sendToPlayer(room.player2Id, statusMsg);
          }
        } else {
          send(ws, { type: 'ERROR', message: 'Game not found or player not in game' }, playerId);
        }
        break;
      }

      case 'CANCEL_GAME': {
        try {
          await gameManager.cancelGame(msg.gameId, playerId);
          send(ws, { type: 'GAME_CANCELLED', gameId: msg.gameId, reason: 'Cancelled by creator' }, playerId);
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'SHARE_AZTEC_INFO': {
        const opponentId = await getOpponentId(msg.gameId, playerId);
        if (opponentId) {
          await sendToPlayer(opponentId, {
            type: 'OPPONENT_AZTEC_INFO',
            gameId: msg.gameId,
            aztecAddress: msg.aztecAddress,
            onChainGameId: msg.onChainGameId,
            gameRandomness: msg.gameRandomness,
          });
        }
        break;
      }

      case 'RELAY_NOTE_DATA': {
        const opponentId = await getOpponentId(msg.gameId, playerId);
        if (opponentId) {
          await sendToPlayer(opponentId, {
            type: 'NOTE_DATA',
            gameId: msg.gameId,
            txHash: msg.txHash,
            notes: msg.notes,
          });
        }
        break;
      }

      case 'SETTLE_STARTED': {
        const opponentId = await getOpponentId(msg.gameId, playerId);
        if (opponentId) {
          await sendToPlayer(opponentId, {
            type: 'OPPONENT_SETTLING',
            gameId: msg.gameId,
            selectedCardId: msg.selectedCardId,
          });
        }
        break;
      }

      case 'QUEUE_MATCHMAKING': {
        try {
          const position = await gameManager.queuePlayer(playerId, msg.cardIds);
          send(ws, { type: 'MATCHMAKING_QUEUED', position }, playerId);

          const match = await gameManager.tryMatch(new Set(clients.keys()));
          if (match) {
            const { entry1, entry2, room } = match;
            await sendToPlayer(entry1.playerId, {
              type: 'MATCH_FOUND',
              gameId: room.id,
              playerNumber: 1,
              gameState: sanitizeGameStateForPlayer(room.state, entry1.playerId, room),
            });
            await sendToPlayer(entry2.playerId, {
              type: 'MATCH_FOUND',
              gameId: room.id,
              playerNumber: 2,
              gameState: sanitizeGameStateForPlayer(room.state, entry2.playerId, room),
            });
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message }, playerId);
        }
        break;
      }

      case 'CANCEL_MATCHMAKING': {
        await gameManager.dequeuePlayer(playerId);
        send(ws, { type: 'MATCHMAKING_CANCELLED' }, playerId);
        break;
      }

      case 'PING': {
        await gameManager.updatePing(playerId);
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

    await gameManager.dequeuePlayer(playerId);

    const gameId = await gameManager.getPlayerGame(playerId);
    if (gameId) {
      const room = await gameManager.getGame(gameId);
      if (room && room.player2Id !== null) {
        const opponentId = room.player1Id === playerId ? room.player2Id : room.player1Id;
        if (opponentId) {
          await sendToPlayer(opponentId, { type: 'OPPONENT_DISCONNECTED', gameId });
        }

        // Set a reconnection window timeout
        const timeout = setTimeout(async () => {
          disconnectTimeouts.delete(playerId);
          // Don't remove the game — keep it for abandoned game recovery.
          // The stale game cleanup timer handles eventual removal.
        }, DISCONNECT_TIMEOUT_MS);
        disconnectTimeouts.set(playerId, timeout);
      } else {
        // Waiting game with no opponent — clean up immediately
        await gameManager.removePlayer(playerId);
      }
    }
  }

  const cleanupInterval = setInterval(async () => {
    await gameManager.cleanupStaleGames();
    await gameManager.cleanupStaleQueue();
  }, CLEANUP_INTERVAL_MS);

  async function close(): Promise<void> {
    clearInterval(cleanupInterval);
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
