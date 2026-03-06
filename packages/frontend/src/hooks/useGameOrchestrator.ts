import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { useGameSession } from './useGameSession';
import { useGameStorage, type PersistedGameState } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { importNotesFromTx } from '../aztec/noteImporter';
import { waitForPxeSync } from '../aztec/pxeSync';
import { MOVE_PROOF_WAIT_TIMEOUT, MOVE_PROOF_POLL_INTERVAL, TOTAL_MOVES } from '../aztec/gameConstants';
import type { Screen, GameState, Player, MoveProofData } from '../types';

/**
 * Map game winner to circuit winner_id value.
 * 0=not ended, 1=player1, 2=player2, 3=draw
 */
export function mapWinnerId(winner: Player | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3;
}

export interface UseGameOrchestratorReturn {
  // Screen routing
  screen: Screen;
  setScreen: (s: Screen) => void;

  // WebSocket state (for components)
  ws: ReturnType<typeof useWebSocket>;

  // Game session (for components)
  session: ReturnType<typeof useGameSession>;

  // Selected cards for current game
  cardIds: number[];

  // Pack opening state
  packResult: { location: string; cardIds: number[] } | null;

  // Whether there is a resumable game saved
  hasGameInProgress: boolean;

  // Actions
  handlePlay: () => void;
  handleCardPacks: () => void;
  handleHandSelected: (ids: number[]) => void;
  handleCancelMatchmaking: () => void;
  handlePackOpened: (location: string, result: { cardIds: number[]; txHash: string | null }) => void;
  handlePackOpenComplete: () => void;
  handlePlaceCard: (handIndex: number, row: number, col: number) => void;
  handleSettle: (selectedCardId: number) => void;
  handleBackToMenu: () => void;
}

export function useGameOrchestrator(wsUrl: string): UseGameOrchestratorReturn {
  const aztec = useAztecContext();
  const ws = useWebSocket(wsUrl);
  const session = useGameSession(aztec.wallet, aztec.accountAddress);
  const storage = useGameStorage();

  const [screen, setScreen] = useState<Screen>('main-menu');
  const [cardIds, setCardIds] = useState<number[]>([]);
  const [packResult, setPackResult] = useState<{ location: string; cardIds: number[] } | null>(null);
  const [hasGameInProgress, setHasGameInProgress] = useState(() => storage.hasGame());

  // Track previous gameState for board-before snapshots
  const prevGameStateRef = useRef<GameState | null>(null);

  // Ref to always access latest move proofs (avoids stale closure in handleSettle)
  const moveProofsRef = useRef(session.collectedMoveProofs);
  moveProofsRef.current = session.collectedMoveProofs;

  // Queue of moves made before hand proofs were ready
  const pendingMovesRef = useRef<Array<{
    cardId: number; handIndex: number; row: number; col: number;
    boardBefore: GameState['board']; boardAfter: GameState['board'];
    scoresBefore: [number, number]; scoresAfter: [number, number];
    gameEnded: boolean; winnerId: number;
  }>>([]);

  // --- One-shot effect guards ---
  const handProofSubmittedRef = useRef(false);
  const aztecInfoSharedRef = useRef(false);
  const onChainCreationStartedRef = useRef(false);
  const noteImportProcessedRef = useRef<string | null>(null);
  const handProofGeneratedRef = useRef(false);

  // --- Effects ---

  // Auto-submit hand proof when generated
  useEffect(() => {
    if (!session.myHandProof || !ws.gameId || handProofSubmittedRef.current) return;
    handProofSubmittedRef.current = true;
    ws.submitHandProof(ws.gameId, session.myHandProof);
  }, [session.myHandProof, ws.gameId, ws.submitHandProof]);

  // Receive opponent hand proof from WebSocket
  useEffect(() => {
    if (!ws.opponentHandProof) return;
    session.setOpponentHandProof(ws.opponentHandProof);
  }, [ws.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // Receive opponent move proof from WebSocket
  useEffect(() => {
    if (!ws.lastMoveProof) return;
    session.addMoveProof(ws.lastMoveProof.moveProof);
  }, [ws.lastMoveProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-generate hand proof when blinding factor + opponent randomness are available
  useEffect(() => {
    if (handProofGeneratedRef.current) return;
    if (!ws.gameId || !ws.gameState || ws.gameState.status !== 'playing') return;
    if (cardIds.length !== 5) return;
    if (!session.blindingFactor) return;
    if (!ws.opponentGameRandomness || ws.opponentGameRandomness.length !== 6) return;

    handProofGeneratedRef.current = true;
    session.generateHandProofFromState(cardIds, ws.opponentGameRandomness).catch(err => {
      console.error('[orchestrator] Hand proof generation failed:', err);
      handProofGeneratedRef.current = false;
    });
  }, [ws.gameId, ws.gameState, cardIds, session.blindingFactor, ws.opponentGameRandomness]); // eslint-disable-line react-hooks/exhaustive-deps

  // Process queued moves once both hand proofs are available
  useEffect(() => {
    if (!session.myHandProof || !session.opponentHandProof) return;
    if (pendingMovesRef.current.length === 0 || !ws.gameId || !ws.playerNumber) return;

    const pending = pendingMovesRef.current.splice(0);
    console.log(`[orchestrator] Processing ${pending.length} queued move(s)`);

    (async () => {
      for (const move of pending) {
        try {
          const moveProof = await session.generateMoveProofForPlacement(
            move.cardId, move.row, move.col, ws.playerNumber!,
            move.boardBefore, move.boardAfter,
            move.scoresBefore, move.scoresAfter,
            move.gameEnded, move.winnerId,
          );
          if (moveProof && ws.gameId) {
            ws.submitMoveProof(ws.gameId, move.handIndex, move.row, move.col, moveProof);
          }
        } catch (err) {
          console.warn('[orchestrator] Deferred move proof failed:', err);
        }
      }
    })();
  }, [session.myHandProof, session.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep previous game state snapshot
  useEffect(() => {
    prevGameStateRef.current = ws.gameState;
  }, [ws.gameState]);

  // Persist game state to localStorage
  useEffect(() => {
    if (!ws.gameId || !ws.playerNumber || cardIds.length === 0) return;
    if (screen !== 'game' && screen !== 'finding-opponent') return;

    const persisted: PersistedGameState = {
      gameId: ws.gameId,
      playerNumber: ws.playerNumber,
      selectedCardIds: cardIds,
      savedAt: Date.now(),
    };
    if (session.onChainGameId) persisted.onChainGameId = session.onChainGameId;
    if (session.myHandProof) persisted.myHandProof = session.myHandProof;
    if (session.opponentHandProof) persisted.opponentHandProof = session.opponentHandProof;
    if (session.collectedMoveProofs.length > 0) persisted.collectedMoveProofs = session.collectedMoveProofs;
    if (ws.opponentAztecAddress) persisted.opponentAztecAddress = ws.opponentAztecAddress;
    if (ws.opponentOnChainGameId) persisted.opponentOnChainGameId = ws.opponentOnChainGameId;
    if (session.gameRandomness) persisted.gameRandomness = session.gameRandomness;
    if (session.blindingFactor) persisted.blindingFactor = session.blindingFactor;
    if (ws.opponentGameRandomness) persisted.opponentGameRandomness = ws.opponentGameRandomness;

    storage.saveGame(persisted);
    setHasGameInProgress(true);
  }, [
    ws.gameId, ws.playerNumber, cardIds, screen,
    session.onChainGameId, session.gameRandomness, session.blindingFactor,
    session.myHandProof, session.opponentHandProof, session.collectedMoveProofs,
    ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentGameRandomness,
    storage,
  ]);

  // Clear saved game on GAME_OVER
  useEffect(() => {
    if (ws.gameOver) {
      storage.clearGame();
      setHasGameInProgress(false);
    }
  }, [ws.gameOver, storage]);

  // Share Aztec address with opponent when game starts
  useEffect(() => {
    if (!ws.gameId || !ws.gameState || !aztec.accountAddress || aztecInfoSharedRef.current) return;
    if (ws.gameState.status !== 'playing') return;
    aztecInfoSharedRef.current = true;
    ws.shareAztecInfo(ws.gameId, aztec.accountAddress, session.onChainGameId ?? undefined);
  }, [ws.gameId, ws.gameState, aztec.accountAddress, session.onChainGameId, ws.shareAztecInfo]);

  // Trigger on-chain game creation/join in background when game starts
  useEffect(() => {
    if (!ws.gameId || !ws.gameState || !ws.playerNumber) return;
    if (ws.gameState.status !== 'playing') return;
    if (onChainCreationStartedRef.current || !session.isContractAvailable) return;
    onChainCreationStartedRef.current = true;

    const startGame = async () => {
      await waitForPxeSync(aztec.wallet, aztec.nodeClient);

      if (ws.playerNumber === 1) {
        const result = await session.createGameOnChain(cardIds);
        if (result && ws.gameId && aztec.accountAddress) {
          ws.shareAztecInfo(ws.gameId, aztec.accountAddress, result.gameId, result.randomness);
          aztec.updateOwnedCards(prev => prev.filter(id => !cardIds.includes(id)));
        }
      } else if (ws.playerNumber === 2 && ws.opponentOnChainGameId) {
        const result = await session.joinGameOnChain(ws.opponentOnChainGameId, cardIds);
        if (result && ws.gameId && aztec.accountAddress) {
          ws.shareAztecInfo(ws.gameId, aztec.accountAddress, ws.opponentOnChainGameId!, result.randomness);
          aztec.updateOwnedCards(prev => prev.filter(id => !cardIds.includes(id)));
        }
      }
    };
    startGame().catch(err => console.error('[orchestrator] On-chain game start failed:', err));
  }, [ws.gameId, ws.gameState, ws.playerNumber, ws.opponentOnChainGameId, session.isContractAvailable, cardIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Player 2: late join when opponent's on-chain game ID arrives
  useEffect(() => {
    if (ws.playerNumber !== 2 || !ws.opponentOnChainGameId) return;
    if (session.onChainGameId || !session.isContractAvailable) return;
    (async () => {
      await waitForPxeSync(aztec.wallet, aztec.nodeClient);
      const result = await session.joinGameOnChain(ws.opponentOnChainGameId!, cardIds);
      if (result && ws.gameId && aztec.accountAddress) {
        ws.shareAztecInfo(ws.gameId, aztec.accountAddress, ws.opponentOnChainGameId!, result.randomness);
        aztec.updateOwnedCards(prev => prev.filter(id => !cardIds.includes(id)));
      }
    })().catch(err => console.error('[orchestrator] Late join failed:', err));
  }, [ws.playerNumber, ws.opponentOnChainGameId, session.onChainGameId, session.isContractAvailable, cardIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset proof state on returning to menu
  useEffect(() => {
    if (screen === 'main-menu') {
      handProofSubmittedRef.current = false;
      pendingMovesRef.current = [];
      aztecInfoSharedRef.current = false;
      onChainCreationStartedRef.current = false;
      noteImportProcessedRef.current = null;
      handProofGeneratedRef.current = false;
      session.reset();
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Matchmaking: transition to game when match found
  useEffect(() => {
    if (ws.matchmakingStatus === 'matched' && screen === 'finding-opponent') {
      setScreen('game');
    }
  }, [ws.matchmakingStatus, screen]);

  // Matchmaking ping
  useEffect(() => {
    if (screen !== 'finding-opponent') return;
    const interval = setInterval(() => ws.ping(), 10000);
    return () => clearInterval(interval);
  }, [screen, ws.ping]);

  // Import notes helper
  const importNotes = useCallback(async (
    txHashStr: string,
    notes: { tokenId: number; randomness: string }[],
    label: string,
  ) => {
    if (!aztec.wallet || !aztec.accountAddress || !aztec.nodeClient) return;
    try {
      const importedIds = await importNotesFromTx(
        aztec.wallet, aztec.nodeClient, aztec.accountAddress,
        txHashStr, notes, label,
      );
      if (importedIds.length > 0) {
        aztec.updateOwnedCards(prev => [...prev, ...importedIds]);
      }
    } catch (err) {
      console.error(`[orchestrator] ${label}: Failed to import notes:`, err);
    }
  }, [aztec.wallet, aztec.accountAddress, aztec.nodeClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Import notes received from opponent via WebSocket
  useEffect(() => {
    if (!ws.incomingNoteData || !aztec.wallet || !aztec.accountAddress) return;
    const { txHash, notes } = ws.incomingNoteData;
    if (noteImportProcessedRef.current === txHash) return;
    noteImportProcessedRef.current = txHash;
    importNotes(txHash, notes, 'Loser import').then(() =>
      waitForPxeSync(aztec.wallet, aztec.nodeClient),
    );
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes]);

  // --- User actions ---

  const handlePlay = useCallback(() => {
    const saved = storage.loadGame();
    if (saved) {
      setCardIds(saved.selectedCardIds);
      if (saved.opponentHandProof) session.setOpponentHandProof(saved.opponentHandProof);
      if (saved.collectedMoveProofs) {
        for (const mp of saved.collectedMoveProofs) session.addMoveProof(mp);
      }
      if (saved.onChainGameId && saved.gameRandomness) {
        session.restoreState(saved.onChainGameId, saved.gameRandomness, saved.blindingFactor);
      }
      ws.queueMatchmaking(saved.selectedCardIds);
      setScreen('finding-opponent');
      return;
    }
    setScreen('card-selector');
  }, [storage, session, ws]);

  const handleCardPacks = useCallback(() => {
    setScreen('card-packs');
  }, []);

  const handleHandSelected = useCallback((ids: number[]) => {
    setCardIds(ids);
    ws.queueMatchmaking(ids);
    setScreen('finding-opponent');
  }, [ws]);

  const handleCancelMatchmaking = useCallback(() => {
    ws.cancelMatchmaking();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, storage]);

  const handlePackOpened = useCallback((location: string, result: { cardIds: number[]; txHash: string | null }) => {
    setPackResult({ location, cardIds: result.cardIds });
    setScreen('pack-opening');
  }, []);

  const handlePackOpenComplete = useCallback(() => {
    setPackResult(prev => {
      if (prev) {
        aztec.updateOwnedCards(cards => [...cards, ...prev.cardIds]);
      }
      return null;
    });
    setScreen('card-packs');
  }, [aztec]);

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    if (!ws.gameState || !ws.playerNumber || !ws.gameId) return;

    const boardBefore = prevGameStateRef.current?.board ?? ws.gameState.board;
    const myHand = ws.playerNumber === 1 ? ws.gameState.player1Hand : ws.gameState.player2Hand;
    const card = myHand[handIndex];

    ws.placeCard(handIndex, row, col);

    if (aztec.isAvailable && card) {
      try {
        const { placeCard: applyMove } = await import('@aztec-triple-triad/game-logic');
        const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';
        const result = applyMove(ws.gameState, myPlayer, handIndex, row, col);
        const boardAfter = result.newState.board;
        const scoresBefore: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];
        const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
        const gameEnded = result.newState.status === 'finished';
        const winnerId = mapWinnerId(result.newState.winner);

        if (session.myHandProof && session.opponentHandProof) {
          const moveProof = await session.generateMoveProofForPlacement(
            card.id, row, col, ws.playerNumber,
            boardBefore, boardAfter,
            scoresBefore, scoresAfter,
            gameEnded, winnerId,
          );
          if (moveProof) {
            ws.submitMoveProof(ws.gameId, handIndex, row, col, moveProof);
          }
        } else {
          pendingMovesRef.current.push({
            cardId: card.id, handIndex, row, col,
            boardBefore: JSON.parse(JSON.stringify(boardBefore)),
            boardAfter: JSON.parse(JSON.stringify(boardAfter)),
            scoresBefore, scoresAfter, gameEnded, winnerId,
          });
        }
      } catch (err) {
        console.warn('[orchestrator] Move proof generation failed:', err);
      }
    }
  }, [ws, aztec.isAvailable, session]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    const currentGameId = ws.gameId;
    if (!currentGameId || !session.myHandProof || !session.opponentHandProof) return;

    const chainGameId = session.onChainGameId ?? ws.opponentOnChainGameId;
    if (!chainGameId) return;

    const opponentAddr = ws.opponentAztecAddress;
    if (!opponentAddr) return;

    const oppCardIds = ws.opponentCardIds;
    if (oppCardIds.length === 0) return;

    // Wait for all move proofs
    if (moveProofsRef.current.length < TOTAL_MOVES) {
      const deadline = Date.now() + MOVE_PROOF_WAIT_TIMEOUT;
      while (moveProofsRef.current.length < TOTAL_MOVES && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, MOVE_PROOF_POLL_INTERVAL));
      }
      if (moveProofsRef.current.length < TOTAL_MOVES) return;
    }

    const myRandomness = session.gameRandomness;
    const oppRandomness = ws.opponentGameRandomness;
    if (!myRandomness || myRandomness.length !== 6 || !oppRandomness || oppRandomness.length !== 6) return;

    const result = await session.settleGame({
      playerNumber: ws.playerNumber!,
      opponentAddress: opponentAddr,
      cardToTransfer: selectedCardId,
      callerCardIds: cardIds,
      opponentCardIds: oppCardIds,
      opponentRandomness: oppRandomness,
    });

    if (result) {
      ws.relayNoteData(currentGameId, result.txHash, result.opponentNotes);
      await importNotes(result.txHash, result.callerNotes, 'Winner import');
      await waitForPxeSync(aztec.wallet, aztec.nodeClient);
    }
  }, [ws, session, cardIds, importNotes, aztec.wallet, aztec.nodeClient]);

  const handleBackToMenu = useCallback(() => {
    ws.leaveGame();
    session.reset();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, session, storage]);

  return {
    screen, setScreen,
    ws, session,
    cardIds, packResult, hasGameInProgress,
    handlePlay, handleCardPacks, handleHandSelected,
    handleCancelMatchmaking, handlePackOpened, handlePackOpenComplete,
    handlePlaceCard, handleSettle, handleBackToMenu,
  };
}
