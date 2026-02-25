import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { GameManager } from './GameManager.js';
import type { ClientMessage, ServerMessage } from './types.js';
import type { GameState } from '@aztec-triple-triad/game-logic';

const DEFAULT_PORT = 3001;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const DISCONNECT_TIMEOUT_MS = 60 * 1000; // 60 seconds reconnection window

// Known client message types
const VALID_MESSAGE_TYPES = new Set([
  'CREATE_GAME', 'JOIN_GAME', 'PLACE_CARD', 'LIST_GAMES', 'GET_GAME',
  'SUBMIT_HAND_PROOF', 'SUBMIT_MOVE_PROOF',
]);

export interface ServerOptions {
  port?: number;
  host?: string;
}

export interface TripleTriadServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  gameManager: GameManager;
  close: () => Promise<void>;
}

export function createServer(options: ServerOptions = {}): TripleTriadServer {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  const gameManager = new GameManager();
  const clients = new Map<string, WebSocket>();

  // Fix 4.4: Restrict CORS to allowed origins
  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://localhost:5173',
  ]);

  const httpServer = http.createServer((req, res) => {
    // CORS headers - restrict to allowed origins
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', games: gameManager.gameCount }));
      return;
    }

    if (req.method === 'GET' && req.url === '/games') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gameManager.listGames()));
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/games/')) {
      const gameId = req.url.slice('/games/'.length);
      const room = gameManager.getGame(gameId);
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

  const wss = new WebSocketServer({ server: httpServer });

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function sendToPlayer(playerId: string, msg: ServerMessage): void {
    const ws = clients.get(playerId);
    if (ws) send(ws, msg);
  }

  function getOpponentId(gameId: string, playerId: string): string | null {
    const room = gameManager.getGame(gameId);
    if (!room) return null;
    if (room.player1Id === playerId) return room.player2Id;
    if (room.player2Id === playerId) return room.player1Id;
    return null;
  }

  function sanitizeGameStateForPlayer(state: GameState, playerId: string, gameId: string): GameState {
    const room = gameManager.getGame(gameId);
    if (!room) return state;

    const isPlayer1 = playerId === room.player1Id;

    // During active game, hide opponent's hand card details
    if (state.status === 'playing') {
      const sanitized = { ...state };
      const hiddenCard = { id: 0, name: 'Hidden', ranks: { top: 0, right: 0, bottom: 0, left: 0 } };
      if (isPlayer1) {
        sanitized.player2Hand = state.player2Hand.map(() => ({ ...hiddenCard }));
      } else {
        sanitized.player1Hand = state.player1Hand.map(() => ({ ...hiddenCard }));
      }
      return sanitized;
    }
    return state;
  }

  // Fix 4.4: Validate incoming message structure before processing
  function validateMessage(msg: any): string | null {
    if (!msg || typeof msg !== 'object' || !msg.type || !VALID_MESSAGE_TYPES.has(msg.type)) {
      return 'Unknown or missing message type';
    }

    switch (msg.type) {
      case 'CREATE_GAME':
        if (!Array.isArray(msg.cardIds)) return 'cardIds must be an array of numbers';
        if (!msg.cardIds.every((id: any) => typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 50)) {
          return 'cardIds must contain integers between 1 and 50';
        }
        break;
      case 'JOIN_GAME':
        if (!msg.gameId || typeof msg.gameId !== 'string') return 'gameId is required and must be a string';
        if (!Array.isArray(msg.cardIds)) return 'cardIds must be an array of numbers';
        if (!msg.cardIds.every((id: any) => typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 50)) {
          return 'cardIds must contain integers between 1 and 50';
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
    }
    return null; // Valid
  }

  // Fix 4.3: Track disconnect timeouts for reconnection window
  const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

  wss.on('connection', (ws: WebSocket) => {
    const playerId = uuidv4();
    clients.set(playerId, ws);

    ws.on('message', (data: Buffer | string) => {
      // Fix 4.4: Reject oversized messages
      const rawData = data.toString();
      if (rawData.length > MAX_MESSAGE_SIZE) {
        send(ws, { type: 'ERROR', message: 'Message too large (max 1MB)' });
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(rawData);
      } catch {
        send(ws, { type: 'ERROR', message: 'Invalid message format' });
        return;
      }

      // Fix 4.4: Validate message structure
      const validationError = validateMessage(msg);
      if (validationError) {
        send(ws, { type: 'ERROR', message: validationError });
        return;
      }

      handleMessage(playerId, ws, msg as ClientMessage);
    });

    ws.on('close', () => {
      handleDisconnect(playerId);
      clients.delete(playerId);
    });

    ws.on('error', () => {
      handleDisconnect(playerId);
      clients.delete(playerId);
    });
  });

  function handleMessage(playerId: string, ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'CREATE_GAME': {
        try {
          const room = gameManager.createGame(playerId, msg.cardIds);
          send(ws, { type: 'GAME_CREATED', gameId: room.id, playerNumber: 1 });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'JOIN_GAME': {
        try {
          const room = gameManager.joinGame(msg.gameId, playerId, msg.cardIds);
          send(ws, {
            type: 'GAME_JOINED',
            gameId: room.id,
            playerNumber: 2,
            gameState: sanitizeGameStateForPlayer(room.state, playerId, room.id),
          });
          // Notify player 1 that the game has started
          sendToPlayer(room.player1Id, {
            type: 'GAME_START',
            gameId: room.id,
            gameState: sanitizeGameStateForPlayer(room.state, room.player1Id, room.id),
          });
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'PLACE_CARD': {
        try {
          const result = gameManager.placeCard(msg.gameId, playerId, msg.handIndex, msg.row, msg.col, msg.moveNumber);

          // Send sanitized state to current player
          send(ws, {
            type: 'GAME_STATE',
            gameId: msg.gameId,
            gameState: sanitizeGameStateForPlayer(result.newState, playerId, msg.gameId),
            captures: result.captures,
          });
          // Send sanitized state to opponent
          const opponentId = getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            sendToPlayer(opponentId, {
              type: 'GAME_STATE',
              gameId: msg.gameId,
              gameState: sanitizeGameStateForPlayer(result.newState, opponentId, msg.gameId),
              captures: result.captures,
            });
          }

          // Check if game is over (finished games reveal all hands)
          if (result.newState.status === 'finished') {
            const overMsg: ServerMessage = {
              type: 'GAME_OVER',
              gameId: msg.gameId,
              gameState: result.newState,
              winner: result.newState.winner!,
            };
            send(ws, overMsg);
            if (opponentId) sendToPlayer(opponentId, overMsg);
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'LIST_GAMES': {
        send(ws, { type: 'GAME_LIST', games: gameManager.listGames() });
        break;
      }

      case 'GET_GAME': {
        const room = gameManager.getGame(msg.gameId);
        if (room) {
          send(ws, {
            type: 'GAME_INFO',
            game: {
              id: room.id,
              status: room.state?.status ?? 'waiting',
              player1Connected: clients.has(room.player1Id),
              player2Connected: room.player2Id ? clients.has(room.player2Id) : false,
              currentTurn: room.state?.currentTurn,
              winner: room.state?.winner,
            },
          });
        } else {
          send(ws, { type: 'GAME_INFO', game: null });
        }
        break;
      }

      case 'SUBMIT_HAND_PROOF': {
        try {
          const room = gameManager.getGame(msg.gameId);
          if (!room) {
            send(ws, { type: 'ERROR', message: 'Game not found' });
            break;
          }
          const playerRole = gameManager.getPlayerRole(msg.gameId, playerId);
          if (!playerRole) {
            send(ws, { type: 'ERROR', message: 'Not in this game' });
            break;
          }
          const fromPlayer = playerRole === 'player1' ? 1 : 2;
          const opponentId = getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            sendToPlayer(opponentId, {
              type: 'HAND_PROOF',
              gameId: msg.gameId,
              handProof: msg.handProof,
              fromPlayer: fromPlayer as 1 | 2,
            });
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }

      case 'SUBMIT_MOVE_PROOF': {
        try {
          // First apply the move on the server (same as PLACE_CARD)
          const result = gameManager.placeCard(msg.gameId, playerId, msg.handIndex, msg.row, msg.col, msg.moveNumber);

          // Send sanitized state update to the current player
          send(ws, {
            type: 'GAME_STATE',
            gameId: msg.gameId,
            gameState: sanitizeGameStateForPlayer(result.newState, playerId, msg.gameId),
            captures: result.captures,
          });

          // Send sanitized move proof + state to the opponent
          const opponentId = getOpponentId(msg.gameId, playerId);
          if (opponentId) {
            sendToPlayer(opponentId, {
              type: 'MOVE_PROVEN',
              gameId: msg.gameId,
              gameState: sanitizeGameStateForPlayer(result.newState, opponentId, msg.gameId),
              captures: result.captures,
              moveProof: msg.moveProof,
              handIndex: msg.handIndex,
              row: msg.row,
              col: msg.col,
            });
          }

          // Check if game is over (finished games reveal all hands)
          if (result.newState.status === 'finished') {
            const overMsg: ServerMessage = {
              type: 'GAME_OVER',
              gameId: msg.gameId,
              gameState: result.newState,
              winner: result.newState.winner!,
            };
            send(ws, overMsg);
            if (opponentId) sendToPlayer(opponentId, overMsg);
          }
        } catch (err: any) {
          send(ws, { type: 'ERROR', message: err.message });
        }
        break;
      }
    }
  }

  function handleDisconnect(playerId: string): void {
    // Fix 4.3: Check if player is in a game and handle cleanup with timeout
    const gameId = gameManager.getPlayerGame(playerId);
    if (gameId) {
      const room = gameManager.getGame(gameId);
      if (room && room.player2Id !== null) {
        // Active game: notify opponent and set cleanup timeout
        const opponentId = room.player1Id === playerId ? room.player2Id : room.player1Id;
        if (opponentId) {
          sendToPlayer(opponentId, { type: 'OPPONENT_DISCONNECTED', gameId });
        }

        // Set a timeout for reconnection; if no reconnection, clean up game
        const timeout = setTimeout(() => {
          disconnectTimeouts.delete(gameId);
          gameManager.removeGame(gameId);
        }, DISCONNECT_TIMEOUT_MS);
        disconnectTimeouts.set(gameId, timeout);
      }
    }

    // Always remove the player (this handles waiting-game cleanup too)
    gameManager.removePlayer(playerId);
  }

  // Periodic cleanup of stale games
  const cleanupInterval = setInterval(() => {
    gameManager.cleanupStaleGames();
  }, CLEANUP_INTERVAL_MS);

  function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      clearInterval(cleanupInterval);
      // Clear disconnect timeouts
      for (const timeout of disconnectTimeouts.values()) {
        clearTimeout(timeout);
      }
      disconnectTimeouts.clear();
      // Close all WebSocket connections
      for (const ws of clients.values()) {
        ws.close();
      }
      clients.clear();
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  return { httpServer, wss, gameManager, close };
}

// Start the server if run directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const port = parseInt(process.env.WS_PORT ?? String(DEFAULT_PORT), 10);
  const server = createServer({ port });
  server.httpServer.listen(port, () => {
    console.log(`Triple Triad server running on port ${port}`);
  });
}
