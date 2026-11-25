import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage, GameState, Player, GameListEntry, MoveProofData, SealedPeerMessage } from '../types';

/**
 * Present-but-idle abandonment warning, as surfaced to the UI. Mirrors the
 * server's GAME_ABANDONMENT_WARNING payload (minus the redundant gameId/type).
 * `idlePlayer` is the player whose turn it is and who has not moved; the OTHER
 * player may claim the game once `secondsUntilClaimable` reaches 0.
 */
export interface AbandonmentWarning {
  idlePlayer: Player;
  secondsIdle: number;
  secondsUntilClaimable: number;
}

const DEFAULT_WS_URL = 'ws://localhost:3001';
const SESSION_TOKEN_KEY = 'aztec_tt_ws_session_token';
const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1000;

export interface UseWebSocketReturn {
  connected: boolean;
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  /** True when the matched opponent is the arena bot (disclosed, never hidden). */
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameList: GameListEntry[];
  error: string | null;
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  /** Live present-but-idle abandonment warning, or null when none is active. */
  abandonmentWarning: AbandonmentWarning | null;
  lastMoveProof: { moveProof: MoveProofData; handIndex: number; row: number; col: number } | null;
  /** Report a mined finalize_abandoned_game tx — the server releases both
   *  players' room bindings and replies with a standard GAME_OVER. Send
   *  only AFTER the tx is mined (QA-F3, docs/plan/LANE_4_BACKEND.md). */
  notifyAbandonedGameSettled: (gameId: string) => void;
  // On-chain tx lifecycle. No tx hash: the relay must not find the game's txs.
  opponentTxConfirmed: boolean;
  notifyTxConfirmed: (gameId: string, txType: 'create_game' | 'join_game') => void;
  /** Our half of the per-game key exchange: only the public key. */
  sendKeyExchange: (gameId: string, publicKey: string) => void;
  /** A player-to-player payload, already sealed with the channel key. */
  sendPeer: (gameId: string, sealed: SealedPeerMessage) => void;
  // Matchmaking
  matchmakingStatus: 'idle' | 'queued' | 'matched';
  queuePosition: number | null;
  createGame: (cardIds: number[]) => void;
  joinGame: (gameId: string, cardIds: number[]) => void;
  placeCard: (handIndex: number, row: number, col: number) => void;
  submitMoveProof: (gameId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData, moveNumber: number) => void;
  refreshGameList: () => void;
  leaveGame: () => void;
  disconnect: () => void;
  // Matchmaking actions
  queueMatchmaking: (cardIds: number[]) => void;
  cancelMatchmaking: () => void;
  ping: () => void;
  // Synchronous message listener — invoked in the WebSocket onmessage handler,
  // NOT deferred to a React render cycle. Use for bridging data into refs that
  // async functions (e.g. txManager execute callbacks) read between awaits.
  // OPPONENT_KEY and PEER reach the app only this way (useGameChannel).
  addMessageListener: (cb: (msg: ServerMessage) => void) => () => void;
}

export function useWebSocket(wsUrl?: string): UseWebSocketReturn {
  const url = wsUrl ?? DEFAULT_WS_URL;
  const messageListenersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const playerNumberRef = useRef<1 | 2 | null>(null);
  /** Mirrors gameId so leaveGame can read it without depending on the state. */
  const gameIdRef = useRef<string | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [playerNumber, setPlayerNumber] = useState<1 | 2 | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastCaptures, setLastCaptures] = useState<{ row: number; col: number }[]>([]);
  const [gameList, setGameList] = useState<GameListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gameOver, setGameOver] = useState<{ winner: Player | 'draw' } | null>(null);
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);
  const [abandonmentWarning, setAbandonmentWarning] = useState<AbandonmentWarning | null>(null);
  const [lastMoveProof, setLastMoveProof] = useState<{ moveProof: MoveProofData; handIndex: number; row: number; col: number } | null>(null);
  const [opponentTxConfirmed, setOpponentTxConfirmed] = useState(false);
  const [matchmakingStatus, setMatchmakingStatus] = useState<'idle' | 'queued' | 'matched'>('idle');
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return; // Already connected or connecting
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send RESUME if we have a session token
      const sessionToken = localStorage.getItem(SESSION_TOKEN_KEY);
      if (sessionToken) {
        ws.send(JSON.stringify({ type: 'RESUME', sessionToken }));
      }
      // Don't set connected=true yet — wait for SESSION_ESTABLISHED
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Auto-reconnect unless intentionally closed
      if (!intentionalCloseRef.current) {
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      setError('Connection failed');
      // onclose will fire after onerror, triggering reconnect
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        console.warn('[useWebSocket] Received malformed JSON, ignoring:', event.data);
        return;
      }
      switch (msg.type) {
        case 'SESSION_ESTABLISHED': {
          const se = msg as { sessionToken: string; playerId: string; resumed: boolean; gameId: string | null };
          localStorage.setItem(SESSION_TOKEN_KEY, se.sessionToken);
          setConnected(true);
          setError(null);
          // Reset reconnect backoff on successful connection
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
          // If resumed into a game, restore context
          if (se.resumed && se.gameId) {
            setGameId(se.gameId);
          }
          break;
        }
        case 'OPPONENT_RECONNECTED':
          setOpponentDisconnected(false);
          break;
        case 'GAME_CREATED':
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          playerNumberRef.current = msg.playerNumber;
          setError(null);
          break;
        case 'GAME_JOINED':
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          playerNumberRef.current = msg.playerNumber;
          setGameState(msg.gameState);
          setError(null);
          break;
        case 'GAME_START':
          setGameState(msg.gameState);
          break;
        case 'GAME_STATE':
          setGameState(msg.gameState);
          setLastCaptures(msg.captures);
          // A board update means someone moved — the idle clock resets.
          setAbandonmentWarning(null);
          break;
        case 'GAME_OVER':
          setGameState(msg.gameState);
          setGameOver({ winner: msg.winner });
          // Game ended — no further abandonment warning applies.
          setAbandonmentWarning(null);
          break;
        case 'GAME_LIST':
          setGameList(msg.games);
          break;
        case 'OPPONENT_DISCONNECTED':
          setOpponentDisconnected(true);
          break;
        case 'GAME_ABANDONMENT_WARNING':
          setAbandonmentWarning({
            idlePlayer: msg.idlePlayer,
            secondsIdle: msg.secondsIdle,
            secondsUntilClaimable: msg.secondsUntilClaimable,
          });
          break;
        case 'MOVE_PROVEN':
          setGameState(msg.gameState);
          setLastCaptures(msg.captures);
          // The opponent proved a move — the idle clock resets.
          setAbandonmentWarning(null);
          setLastMoveProof({
            moveProof: msg.moveProof,
            handIndex: msg.handIndex,
            row: msg.row,
            col: msg.col,
          });
          break;
        case 'OPPONENT_KEY':
        case 'PEER':
          // Handled by the game channel's listener (useGameChannel): the
          // payloads are sealed, and only it holds the keys.
          break;
        case 'ON_CHAIN_STATUS': {
          const s = msg.status;
          const myRole = playerNumberRef.current;
          if (myRole === 2 && s.player1Tx === 'confirmed') {
            setOpponentTxConfirmed(true);
          } else if (myRole === 1 && s.player2Tx === 'confirmed') {
            setOpponentTxConfirmed(true);
          }
          break;
        }
        case 'MATCHMAKING_QUEUED':
          setMatchmakingStatus('queued');
          setQueuePosition(msg.position);
          break;
        case 'MATCH_FOUND':
          setMatchmakingStatus('matched');
          setQueuePosition(null);
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          playerNumberRef.current = msg.playerNumber;
          setGameState(msg.gameState);
          // Disclosure: the server tells us when the opponent is the arena bot.
          // Defaults to false so a server that does not send it reads as human.
          setError(null);
          break;
        case 'MATCHMAKING_CANCELLED':
          setMatchmakingStatus('idle');
          setQueuePosition(null);
          break;
        case 'PONG':
          break;
        case 'ERROR':
          setError(msg.message);
          break;
      }
      // Invoke synchronous listeners (runs in the same event loop tick)
      for (const cb of messageListenersRef.current) cb(msg);
    };
  }, [url]);

  useEffect(() => {
    let cancelled = false;

    // Delay connection slightly to survive React StrictMode's
    // mount → unmount → remount cycle without wasting a connection.
    const timer = setTimeout(() => {
      if (cancelled) return;
      intentionalCloseRef.current = false;
      connect();
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }
      wsRef.current = null;
    };
  }, [connect]);

  const createGame = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    send({ type: 'CREATE_GAME', cardIds });
  }, [send]);

  const joinGame = useCallback((id: string, cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    send({ type: 'JOIN_GAME', gameId: id, cardIds });
  }, [send]);

  const placeCard = useCallback((handIndex: number, row: number, col: number) => {
    if (!gameId) return;
    setError(null);
    // Derive global move number from board state (count occupied cells).
    // Server's expectedMoveNumber is a global counter for ALL moves (both players),
    // so each client must send the total move count, not a per-player count.
    let moveNumber = 0;
    if (gameState) {
      for (const row of gameState.board) {
        for (const cell of row) {
          if (cell.card !== null) moveNumber++;
        }
      }
    }
    send({ type: 'PLACE_CARD', gameId, handIndex, row, col, moveNumber });
  }, [send, gameId, gameState]);

  const refreshGameList = useCallback(() => {
    send({ type: 'LIST_GAMES' });
  }, [send]);

  const submitMoveProof = useCallback((gId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData, moveNumber: number) => {
    if (!gId) return;
    setError(null);
    send({ type: 'SUBMIT_MOVE_PROOF', gameId: gId, handIndex, row, col, moveNumber, moveProof });
  }, [send]);

  const notifyAbandonedGameSettled = useCallback((gId: string) => {
    send({ type: 'ABANDONED_GAME_SETTLED', gameId: gId });
  }, [send]);

  const notifyTxConfirmed = useCallback((gId: string, txType: 'create_game' | 'join_game') => {
    send({ type: 'TX_CONFIRMED', gameId: gId, txType });
  }, [send]);

  const sendKeyExchange = useCallback((gId: string, publicKey: string) => {
    send({ type: 'KEY_EXCHANGE', gameId: gId, publicKey });
  }, [send]);

  const sendPeer = useCallback((gId: string, sealed: SealedPeerMessage) => {
    send({ type: 'PEER', gameId: gId, iv: sealed.iv, ciphertext: sealed.ciphertext });
  }, [send]);

  const queueMatchmaking = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setMatchmakingStatus('idle');
    setAbandonmentWarning(null);
    send({ type: 'QUEUE_MATCHMAKING', cardIds });
  }, [send]);

  const cancelMatchmaking = useCallback(() => {
    send({ type: 'CANCEL_MATCHMAKING' });
    setMatchmakingStatus('idle');
    setQueuePosition(null);
  }, [send]);

  const ping = useCallback(() => {
    send({ type: 'PING' });
  }, [send]);

  const addMessageListener = useCallback((cb: (msg: ServerMessage) => void) => {
    messageListenersRef.current.add(cb);
    return () => { messageListenersRef.current.delete(cb); };
  }, []);

  useEffect(() => { gameIdRef.current = gameId; }, [gameId]);

  /**
   * Reset all game-related state but keep the WebSocket connection open.
   *
   * Tells the relay too. It releases both players at GAME OVER, but a game
   * left before that — abandoned, or walked away from — keeps its binding
   * until the stale-game sweep, and every queue attempt until then is refused
   * with "You are already in an active game". The bot spent 22 minutes and 578
   * attempts in exactly that state; a player would simply be unable to start
   * another game. Only the sender is released — the game itself stays, because
   * its committed cards still need the abandonment claim.
   */
  const leaveGame = useCallback(() => {
    const leaving = gameIdRef.current;
    if (leaving) send({ type: 'LEAVE_GAME', gameId: leaving });
    setGameId(null);
    setPlayerNumber(null);
    setGameState(null);
    setLastCaptures([]);
    setGameOver(null);
    setError(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    setLastMoveProof(null);
    setOpponentTxConfirmed(false);
    setMatchmakingStatus('idle');
    setQueuePosition(null);
    playerNumberRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    localStorage.removeItem(SESSION_TOKEN_KEY);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close();
    leaveGame();
  }, [leaveGame]);

  return {
    connected,
    gameId,
    playerNumber,
    gameState,
    lastCaptures,
    gameList,
    error,
    gameOver,
    opponentDisconnected,
    abandonmentWarning,
    lastMoveProof,
    notifyAbandonedGameSettled,
    opponentTxConfirmed,
    notifyTxConfirmed,
    sendKeyExchange,
    sendPeer,
    matchmakingStatus,
    queuePosition,
    createGame,
    joinGame,
    placeCard,
    submitMoveProof,
    refreshGameList,
    leaveGame,
    disconnect,
    queueMatchmaking,
    cancelMatchmaking,
    ping,
    addMessageListener,
  };
}
