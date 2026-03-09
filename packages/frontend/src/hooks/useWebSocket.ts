import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage, GameState, Player, GameListEntry, HandProofData, MoveProofData, PlaintextNoteData } from '../types';

const DEFAULT_WS_URL = 'ws://localhost:3001';

export interface UseWebSocketReturn {
  connected: boolean;
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameList: GameListEntry[];
  error: string | null;
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  opponentHandProof: HandProofData | null;
  lastMoveProof: { moveProof: MoveProofData; handIndex: number; row: number; col: number } | null;
  opponentAztecAddress: string | null;
  opponentOnChainGameId: string | null;
  opponentCardIds: number[];
  // Note relay (offchain settlement delivery)
  incomingNoteData: { txHash: string; notes: PlaintextNoteData[] } | null;
  relayNoteData: (gameId: string, txHash: string, notes: PlaintextNoteData[]) => void;
  // On-chain tx lifecycle
  opponentTxConfirmed: boolean;
  notifyTxConfirmed: (gameId: string, txType: 'create_game' | 'join_game', txHash: string) => void;
  // Matchmaking
  matchmakingStatus: 'idle' | 'queued' | 'matched';
  queuePosition: number | null;
  createGame: (cardIds: number[]) => void;
  joinGame: (gameId: string, cardIds: number[]) => void;
  placeCard: (handIndex: number, row: number, col: number) => void;
  submitHandProof: (gameId: string, handProof: HandProofData) => void;
  submitMoveProof: (gameId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData, moveNumber: number) => void;
  shareAztecInfo: (gameId: string, aztecAddress: string, onChainGameId?: string, gameRandomness?: string[]) => void;
  opponentGameRandomness: string[] | null;
  refreshGameList: () => void;
  leaveGame: () => void;
  disconnect: () => void;
  // Matchmaking actions
  queueMatchmaking: (cardIds: number[]) => void;
  cancelMatchmaking: () => void;
  ping: () => void;
}

export function useWebSocket(wsUrl?: string): UseWebSocketReturn {
  const url = wsUrl ?? DEFAULT_WS_URL;
  const wsRef = useRef<WebSocket | null>(null);
  const playerNumberRef = useRef<1 | 2 | null>(null);
  const [connected, setConnected] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [playerNumber, setPlayerNumber] = useState<1 | 2 | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastCaptures, setLastCaptures] = useState<{ row: number; col: number }[]>([]);
  const [gameList, setGameList] = useState<GameListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gameOver, setGameOver] = useState<{ winner: Player | 'draw' } | null>(null);
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [lastMoveProof, setLastMoveProof] = useState<{ moveProof: MoveProofData; handIndex: number; row: number; col: number } | null>(null);
  const [opponentAztecAddress, setOpponentAztecAddress] = useState<string | null>(null);
  const [opponentOnChainGameId, setOpponentOnChainGameId] = useState<string | null>(null);
  const [opponentCardIds, setOpponentCardIds] = useState<number[]>([]);
  const [incomingNoteData, setIncomingNoteData] = useState<{ txHash: string; notes: PlaintextNoteData[] } | null>(null);
  const [opponentGameRandomness, setOpponentGameRandomness] = useState<string[] | null>(null);
  const [opponentTxConfirmed, setOpponentTxConfirmed] = useState(false);
  const [matchmakingStatus, setMatchmakingStatus] = useState<'idle' | 'queued' | 'matched'>('idle');
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;

    // Delay connection slightly to survive React StrictMode's
    // mount → unmount → remount cycle without wasting a connection.
    const timer = setTimeout(() => {
      if (cancelled) return;

      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        setConnected(true);
        setError(null);
      };

      ws.onclose = () => {
        if (!cancelled) setConnected(false);
      };

      ws.onerror = () => {
        if (cancelled) return;
        setError('Connection failed');
        setConnected(false);
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          console.warn('[useWebSocket] Received malformed JSON, ignoring:', event.data);
          return;
        }
        switch (msg.type) {
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
            break;
          case 'GAME_OVER':
            setGameState(msg.gameState);
            setGameOver({ winner: msg.winner });
            // Extract opponent card IDs from GAME_OVER message
            if (playerNumberRef.current) {
              const oppIds = playerNumberRef.current === 1 ? msg.player2CardIds : msg.player1CardIds;
              if (oppIds && oppIds.length > 0) setOpponentCardIds(oppIds);
            }
            break;
          case 'GAME_LIST':
            setGameList(msg.games);
            break;
          case 'OPPONENT_DISCONNECTED':
            setOpponentDisconnected(true);
            break;
          case 'HAND_PROOF':
            setOpponentHandProof(msg.handProof);
            break;
          case 'MOVE_PROVEN':
            setGameState(msg.gameState);
            setLastCaptures(msg.captures);
            setLastMoveProof({
              moveProof: msg.moveProof,
              handIndex: msg.handIndex,
              row: msg.row,
              col: msg.col,
            });
            break;
          case 'OPPONENT_AZTEC_INFO':
            setOpponentAztecAddress(msg.aztecAddress);
            if (msg.onChainGameId) setOpponentOnChainGameId(msg.onChainGameId);
            if (msg.gameRandomness) setOpponentGameRandomness(msg.gameRandomness);
            break;
          case 'NOTE_DATA':
            setIncomingNoteData({ txHash: msg.txHash, notes: msg.notes });
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
            setError(null);
            break;
          case 'MATCHMAKING_CANCELLED':
            setMatchmakingStatus('idle');
            setQueuePosition(null);
            break;
          case 'PONG':
            // Keep-alive acknowledged
            break;
          case 'ERROR':
            setError(msg.message);
            break;
        }
      };
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [url]);

  const createGame = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    send({ type: 'CREATE_GAME', cardIds });
  }, [send]);

  const joinGame = useCallback((id: string, cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
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

  const submitHandProof = useCallback((gId: string, handProof: HandProofData) => {
    setError(null);
    send({ type: 'SUBMIT_HAND_PROOF', gameId: gId, handProof });
  }, [send]);

  const shareAztecInfo = useCallback((gId: string, aztecAddress: string, onChainGameId?: string, gameRandomness?: string[]) => {
    send({ type: 'SHARE_AZTEC_INFO', gameId: gId, aztecAddress, onChainGameId, gameRandomness });
  }, [send]);

  const submitMoveProof = useCallback((gId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData, moveNumber: number) => {
    if (!gId) return;
    setError(null);
    send({ type: 'SUBMIT_MOVE_PROOF', gameId: gId, handIndex, row, col, moveNumber, moveProof });
  }, [send]);

  const relayNoteData = useCallback((gId: string, txHash: string, notes: PlaintextNoteData[]) => {
    send({ type: 'RELAY_NOTE_DATA', gameId: gId, txHash, notes });
  }, [send]);

  const notifyTxConfirmed = useCallback((gId: string, txType: 'create_game' | 'join_game', txHash: string) => {
    send({ type: 'TX_CONFIRMED', gameId: gId, txType, txHash });
  }, [send]);

  const queueMatchmaking = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setMatchmakingStatus('idle');
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

  /** Reset all game-related state but keep the WebSocket connection open. */
  const leaveGame = useCallback(() => {
    setGameId(null);
    setPlayerNumber(null);
    setGameState(null);
    setLastCaptures([]);
    setGameOver(null);
    setError(null);
    setOpponentDisconnected(false);
    setOpponentHandProof(null);
    setLastMoveProof(null);
    setOpponentAztecAddress(null);
    setOpponentOnChainGameId(null);
    setOpponentCardIds([]);
    setIncomingNoteData(null);
    setOpponentGameRandomness(null);
    setOpponentTxConfirmed(false);
    setMatchmakingStatus('idle');
    setQueuePosition(null);
    playerNumberRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
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
    opponentHandProof,
    lastMoveProof,
    opponentAztecAddress,
    opponentOnChainGameId,
    opponentCardIds,
    incomingNoteData,
    opponentGameRandomness,
    opponentTxConfirmed,
    relayNoteData,
    notifyTxConfirmed,
    matchmakingStatus,
    queuePosition,
    createGame,
    joinGame,
    placeCard,
    submitHandProof,
    submitMoveProof,
    shareAztecInfo,
    refreshGameList,
    leaveGame,
    disconnect,
    queueMatchmaking,
    cancelMatchmaking,
    ping,
  };
}
