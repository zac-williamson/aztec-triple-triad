import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAztec } from './hooks/useAztec';
import { useGameFlow } from './hooks/useGameFlow';
import { useGameContract } from './hooks/useGameContract';
import { useGameStorage } from './hooks/useGameStorage';
import type { PersistedGameState } from './hooks/useGameStorage';
import { MenuScene } from './components3d/MenuScene';
import { MainMenu } from './components/MainMenu';
import { CardSelector } from './components/CardSelector';
import { FindingOpponent } from './components/FindingOpponent';
import { CardPacks } from './components/CardPacks';
import { PackOpening } from './components/PackOpening';
import { GameScreen3D as GameScreen } from './components3d/GameScreen3D';
import type { Screen, GameState } from './types';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

/**
 * Map game winner to circuit winner_id value.
 * 0=not ended, 1=player1, 2=player2, 3=draw
 */
export function mapWinnerId(winner: 'player1' | 'player2' | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3; // draw
}

export function App() {
  const [screen, setScreen] = useState<Screen>('main-menu');
  const [cardIds, setCardIds] = useState<number[]>([]);
  const [selectedHandIds, setSelectedHandIds] = useState<number[]>([]);
  const [packResult, setPackResult] = useState<{ location: string; cardIds: number[] } | null>(null);
  const ws = useWebSocket(WS_URL);

  // Aztec hooks — auto-connect on mount
  const aztec = useAztec();
  const aztecConnectAttempted = useRef(false);
  useEffect(() => {
    if (aztec.status === 'disconnected' && !aztecConnectAttempted.current) {
      aztecConnectAttempted.current = true;
      aztec.connect();
    }
  }, [aztec.status, aztec.connect]);
  const gameContract = useGameContract(aztec.wallet, aztec.accountAddress);
  const gameFlow = useGameFlow({
    gameId: ws.gameId,
    playerNumber: ws.playerNumber,
    cardIds,
    gameState: ws.gameState,
    wallet: aztec.wallet,
    accountAddress: aztec.accountAddress,
    opponentGameRandomness: ws.opponentGameRandomness,
    derivedBlindingFactor: gameContract.blindingFactor,
  });
  const gameStorage = useGameStorage();

  // Whether there is a resumable game saved in localStorage
  const [hasGameInProgress, setHasGameInProgress] = useState(() => gameStorage.hasGame());

  // Track previous gameState for board-before snapshots
  const prevGameStateRef = useRef<GameState | null>(null);

  // Ref to always access latest move proofs (avoids stale closure in handleSettle)
  const moveProofsRef = useRef(gameFlow.collectedMoveProofs);
  moveProofsRef.current = gameFlow.collectedMoveProofs;

  // Opponent card IDs come from GAME_OVER message via ws.opponentCardIds

  // Queue of moves made before hand proofs were ready, so we can retroactively generate proofs
  const pendingMovesRef = useRef<Array<{
    cardId: number; handIndex: number; row: number; col: number;
    boardBefore: GameState['board']; boardAfter: GameState['board'];
    scoresBefore: [number, number]; scoresAfter: [number, number];
    gameEnded: boolean; winnerId: number;
  }>>([]);

  // --- Effects for proof flow ---

  // 1. Auto-submit hand proof when it's generated
  const handProofSubmittedRef = useRef(false);
  useEffect(() => {
    if (!gameFlow.myHandProof || !ws.gameId || handProofSubmittedRef.current) return;
    handProofSubmittedRef.current = true;
    ws.submitHandProof(ws.gameId, gameFlow.myHandProof);
  }, [gameFlow.myHandProof, ws.gameId, ws]);

  // 2. Receive opponent hand proof from WebSocket
  useEffect(() => {
    if (!ws.opponentHandProof) return;
    gameFlow.setOpponentHandProof(ws.opponentHandProof);
  }, [ws.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3. Receive opponent move proof from WebSocket
  useEffect(() => {
    if (!ws.lastMoveProof) return;
    gameFlow.addMoveProof(ws.lastMoveProof.moveProof);
  }, [ws.lastMoveProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3b. Process queued moves once both hand proofs are available
  useEffect(() => {
    if (!gameFlow.myHandProof || !gameFlow.opponentHandProof) return;
    if (pendingMovesRef.current.length === 0) return;
    if (!ws.gameId) return;

    const pending = pendingMovesRef.current.splice(0);
    console.log(`[App] Processing ${pending.length} queued move(s) for deferred proof gen`);

    (async () => {
      for (const move of pending) {
        try {
          const moveProof = await gameFlow.generateMoveProofForPlacement(
            move.cardId, move.row, move.col,
            move.boardBefore, move.boardAfter,
            move.scoresBefore, move.scoresAfter,
            move.gameEnded, move.winnerId,
          );
          if (moveProof && ws.gameId) {
            ws.submitMoveProof(ws.gameId, move.handIndex, move.row, move.col, moveProof);
          }
        } catch (err) {
          console.warn('[App] Deferred move proof generation failed:', err);
        }
      }
    })();
  }, [gameFlow.myHandProof, gameFlow.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4. Keep previous game state snapshot for proof generation
  useEffect(() => {
    prevGameStateRef.current = ws.gameState;
  }, [ws.gameState]);

  // 4b. Persist game state to localStorage whenever key values change
  useEffect(() => {
    if (!ws.gameId || !ws.playerNumber || cardIds.length === 0) return;
    // Only persist while in-game (not after returning to menu)
    if (screen !== 'game' && screen !== 'finding-opponent') return;

    const persisted: PersistedGameState = {
      gameId: ws.gameId,
      playerNumber: ws.playerNumber,
      selectedCardIds: cardIds,
      savedAt: Date.now(),
    };
    if (gameContract.onChainGameId) persisted.onChainGameId = gameContract.onChainGameId;
    if (gameFlow.myHandProof) persisted.myHandProof = gameFlow.myHandProof;
    if (gameFlow.opponentHandProof) persisted.opponentHandProof = gameFlow.opponentHandProof;
    if (gameFlow.collectedMoveProofs.length > 0) persisted.collectedMoveProofs = gameFlow.collectedMoveProofs;
    if (ws.opponentAztecAddress) persisted.opponentAztecAddress = ws.opponentAztecAddress;
    if (ws.opponentOnChainGameId) persisted.opponentOnChainGameId = ws.opponentOnChainGameId;
    if (gameContract.gameRandomness) persisted.gameRandomness = gameContract.gameRandomness;
    if (gameContract.blindingFactor) persisted.blindingFactor = gameContract.blindingFactor;
    if (ws.opponentGameRandomness) persisted.opponentGameRandomness = ws.opponentGameRandomness;

    gameStorage.saveGame(persisted);
    setHasGameInProgress(true);
  }, [
    ws.gameId, ws.playerNumber, cardIds, screen,
    gameContract.onChainGameId, gameContract.gameRandomness, gameContract.blindingFactor,
    gameFlow.myHandProof, gameFlow.opponentHandProof, gameFlow.collectedMoveProofs,
    ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentGameRandomness,
    gameStorage,
  ]);

  // 4c. Clear saved game when the game finishes (GAME_OVER received)
  useEffect(() => {
    if (ws.gameOver) {
      gameStorage.clearGame();
      setHasGameInProgress(false);
    }
  }, [ws.gameOver, gameStorage]);

  // 5. Share Aztec address with opponent when game starts and Aztec is connected
  const aztecInfoSharedRef = useRef(false);
  useEffect(() => {
    if (!ws.gameId || !ws.gameState || !aztec.accountAddress || aztecInfoSharedRef.current) return;
    if (ws.gameState.status !== 'playing') return;
    aztecInfoSharedRef.current = true;
    ws.shareAztecInfo(ws.gameId, aztec.accountAddress, gameContract.onChainGameId ?? undefined);
    console.log('[App] Shared Aztec address with opponent:', aztec.accountAddress);
  }, [ws.gameId, ws.gameState, aztec.accountAddress, gameContract.onChainGameId, ws]);

  // 6. Trigger on-chain game creation in background when game starts
  const onChainCreationStartedRef = useRef(false);
  useEffect(() => {
    if (!ws.gameId || !ws.gameState || !ws.playerNumber) return;
    if (ws.gameState.status !== 'playing') return;
    if (onChainCreationStartedRef.current) return;
    if (!gameContract.isAvailable) return;
    onChainCreationStartedRef.current = true;

    // Wait for PXE to sync before committing cards — ensures stale notes from
    // previous games are marked as nullified so pop_notes won't select them.
    const startGame = async () => {
      await waitForPxeSync();

      if (ws.playerNumber === 1) {
        const result = await gameContract.createGameOnChain(cardIds);
        if (result && ws.gameId && aztec.accountAddress) {
          ws.shareAztecInfo(ws.gameId, aztec.accountAddress, result.gameId, result.randomness);
          console.log('[App] On-chain game created, shared ID:', result.gameId);
          // Remove committed cards from owned list (they've been nullified on-chain)
          aztec.updateOwnedCards(prev => prev.filter(id => !cardIds.includes(id)));
        } else {
          console.error('[App] createGameOnChain returned null — on-chain game creation failed');
        }
      } else if (ws.playerNumber === 2 && ws.opponentOnChainGameId) {
        const result = await gameContract.joinGameOnChain(ws.opponentOnChainGameId, cardIds);
        if (result && ws.gameId && aztec.accountAddress) {
          ws.shareAztecInfo(ws.gameId, aztec.accountAddress, ws.opponentOnChainGameId!, result.randomness);
          console.log('[App] Joined on-chain game, shared randomness');
          // Remove committed cards from owned list (they've been nullified on-chain)
          aztec.updateOwnedCards(prev => prev.filter(id => !cardIds.includes(id)));
        } else {
          console.error('[App] joinGameOnChain returned null — on-chain join failed');
        }
      }
    };
    startGame().catch((err) => {
      console.error('[App] On-chain game creation/join threw:', err);
    });
  }, [ws.gameId, ws.gameState, ws.playerNumber, ws.opponentOnChainGameId, gameContract.isAvailable, cardIds, aztec.accountAddress, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 6b. Player 2: join on-chain game when we receive opponent's on-chain game ID later
  useEffect(() => {
    if (ws.playerNumber !== 2 || !ws.opponentOnChainGameId) return;
    if (gameContract.onChainGameId) return; // already joined
    if (!gameContract.isAvailable) return;
    (async () => {
      await waitForPxeSync();
      const result = await gameContract.joinGameOnChain(ws.opponentOnChainGameId!, cardIds);
      if (result && ws.gameId && aztec.accountAddress) {
        ws.shareAztecInfo(ws.gameId, aztec.accountAddress, ws.opponentOnChainGameId!, result.randomness);
        console.log('[App] Joined on-chain game (late), shared randomness');
        aztec.updateOwnedCards(prev => prev.filter(id => !cardIds.includes(id)));
      } else {
        console.error('[App] joinGameOnChain (late) returned null');
      }
    })().catch((err) => {
      console.error('[App] joinGameOnChain (late) threw:', err);
    });
  }, [ws.playerNumber, ws.opponentOnChainGameId, gameContract.onChainGameId, gameContract.isAvailable, cardIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset proof state on returning to menu
  useEffect(() => {
    if (screen === 'main-menu') {
      handProofSubmittedRef.current = false;
      pendingMovesRef.current = [];
      aztecInfoSharedRef.current = false;
      onChainCreationStartedRef.current = false;
      noteImportProcessedRef.current = null;
      gameFlow.reset();
    }
  }, [screen, gameFlow.reset]);

  // Matchmaking: transition to game when match found
  useEffect(() => {
    if (ws.matchmakingStatus === 'matched' && screen === 'finding-opponent') {
      setScreen('game');
    }
  }, [ws.matchmakingStatus, screen]);

  // Matchmaking ping interval
  useEffect(() => {
    if (screen !== 'finding-opponent') return;
    const interval = setInterval(() => ws.ping(), 10000);
    return () => clearInterval(interval);
  }, [screen, ws]);

  // Wait for PXE block sync to catch up to the node's latest block.
  // This ensures nullifiers from recent txs are processed so pop_notes won't select stale notes.
  const waitForPxeSync = useCallback(async () => {
    const w = aztec.wallet as any;
    const node = aztec.nodeClient as any;
    if (!w || !node) return;
    try {
      const targetBlock = await node.getBlockNumber();
      console.log(`[App] Waiting for PXE sync to block ${targetBlock}...`);
      for (let i = 0; i < 30; i++) {
        const header = await w.getSyncedBlockHeader();
        const syncedBlock = Number(header.globalVariables?.blockNumber ?? 0);
        if (syncedBlock >= targetBlock) {
          console.log(`[App] PXE synced to block ${syncedBlock}`);
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      console.warn('[App] PXE sync timeout — proceeding anyway');
    } catch (err) {
      console.warn('[App] PXE sync check failed:', err);
    }
  }, [aztec.wallet, aztec.nodeClient]);

  // 7. Import notes helper — used by both winner (self-import) and loser (via WebSocket relay).
  //    Notes created by create_and_push_note skip delivery/tagging, so PXE sync won't find
  //    them automatically. Both players must explicitly call import_note to discover their notes.
  const importNotesForTx = useCallback(async (
    txHashStr: string,
    notes: { tokenId: number; randomness: string }[],
    label: string,
  ) => {
    if (!aztec.wallet || !aztec.accountAddress) return;
    try {
      const { AztecAddress } = await import('@aztec/aztec.js/addresses');
      const { Fr } = await import('@aztec/aztec.js/fields');
      const { Contract } = await import('@aztec/aztec.js/contracts');
      const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
      const { AZTEC_CONFIG } = await import('./aztec/config');

      const myAddr = AztecAddress.fromString(aztec.accountAddress!);
      const node = aztec.nodeClient as any;

      // Safe Fr conversion — handles hex strings, decimal strings, and Fr objects
      const toFr = (v: any): InstanceType<typeof Fr> => {
        if (v instanceof Fr) return v;
        const s = v.toString();
        if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
        return new Fr(BigInt(s));
      };

      // Get TxEffect for note hash data
      const { TxHash } = await import('@aztec/stdlib/tx');
      const hash = TxHash.fromString(txHashStr);

      // Retry fetching TxEffect (the tx may have just been mined)
      let txEffect: any = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const txResult = await node.getTxEffect(hash);
        if (txResult?.data) {
          txEffect = txResult.data;
          break;
        }
        console.log(`[App] TxEffect not available yet (attempt ${attempt + 1}/5), waiting...`);
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!txEffect) {
        console.error(`[App] Could not fetch TxEffect for ${txHashStr} after retries`);
        return;
      }

      // Extract unique note hashes and first nullifier from TxEffect
      const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
      const uniqueNoteHashes: string[] = rawNoteHashes
        .map((h: any) => h.toString())
        .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
      const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

      console.log(`[App] ${label}: TxEffect has ${uniqueNoteHashes.length} non-zero note hashes, firstNullifier=${firstNullifier.slice(0, 18)}...`);

      const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress!);

      // Load NFT contract
      const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
      if (!resp.ok) throw new Error('Failed to load NFT contract artifact');
      const artifact = loadContractArtifact(await resp.json());
      const nftContract = await Contract.at(nftAddr, artifact, aztec.wallet as never);

      // Build padded note hashes array once
      const paddedHashes = new Array(64).fill(new Fr(0n));
      for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
        paddedHashes[i] = toFr(uniqueNoteHashes[i]);
      }
      const txHashFr = toFr(txHashStr);
      const firstNullFr = toFr(firstNullifier);

      // Import each note via import_note utility function
      for (const note of notes) {
        console.log(`[App] ${label}: importing note tokenId=${note.tokenId} randomness=${note.randomness.slice(0, 18)}...`);
        await nftContract.methods
          .import_note(
            myAddr,
            new Fr(BigInt(note.tokenId)),
            toFr(note.randomness),
            txHashFr,
            paddedHashes,
            uniqueNoteHashes.length,
            firstNullFr,
            myAddr,
          )
          .simulate({ from: myAddr });
      }

      console.log(`[App] ${label}: Imported ${notes.length} notes successfully`);
      // Directly add imported card IDs to the owned cards list.
      // We do NOT call refreshOwnedCards() here because PXE's view_notes
      // returns stale (already-nullified) notes alongside new ones after settlement.
      const importedIds = notes.map(n => n.tokenId);
      aztec.updateOwnedCards(prev => {
        const combined = [...prev, ...importedIds];
        console.log(`[App] ${label}: Updated owned cards:`, combined);
        return combined;
      });
    } catch (err) {
      console.error(`[App] ${label}: Failed to import notes:`, err);
    }
  }, [aztec.wallet, aztec.accountAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // 7a. Import notes received from opponent via WebSocket (loser/draw flow)
  const noteImportProcessedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ws.incomingNoteData || !aztec.wallet || !aztec.accountAddress) return;
    const { txHash, notes } = ws.incomingNoteData;
    console.log('[App] Incoming websocket note data:', JSON.stringify(ws.incomingNoteData));
    // Avoid re-processing the same relay
    if (noteImportProcessedRef.current === txHash) return;
    noteImportProcessedRef.current = txHash;
    // Import notes then wait for PXE sync (so nullifiers from create_game are processed)
    importNotesForTx(txHash, notes, 'Loser import').then(() => waitForPxeSync());
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, importNotesForTx, waitForPxeSync]);

  const handlePlay = useCallback(() => {
    // If there is a saved game, try to resume it
    const saved = gameStorage.loadGame();
    if (saved) {
      console.log('[App] Resuming saved game:', saved.gameId);
      setCardIds(saved.selectedCardIds);
      setSelectedHandIds(saved.selectedCardIds);
      // Restore proofs that were persisted
      if (saved.opponentHandProof) {
        gameFlow.setOpponentHandProof(saved.opponentHandProof);
      }
      if (saved.collectedMoveProofs) {
        for (const mp of saved.collectedMoveProofs) {
          gameFlow.addMoveProof(mp);
        }
      }
      // Restore on-chain game state (randomness) if previously committed
      if (saved.onChainGameId && saved.gameRandomness) {
        gameContract.restoreState(saved.onChainGameId, saved.gameRandomness, saved.blindingFactor);
      }
      // Re-queue matchmaking so the WebSocket server can reconnect us to the game
      ws.queueMatchmaking(saved.selectedCardIds);
      setScreen('finding-opponent');
      return;
    }
    // Note: we no longer call refreshOwnedCards() here because PXE's view_notes
    // returns stale (already-nullified) notes after settlement. The ownedCardIds
    // state is maintained directly via updateOwnedCards throughout the game lifecycle.
    setScreen('card-selector');
  }, [gameStorage, gameFlow, ws]);

  const handleTutorial = useCallback(() => {
    // Coming soon
  }, []);

  const handleCardPacks = useCallback(() => {
    setScreen('card-packs');
  }, []);

  const handleHandSelected = useCallback((ids: number[]) => {
    setSelectedHandIds(ids);
    setCardIds(ids);
    ws.queueMatchmaking(ids);
    setScreen('finding-opponent');
  }, [ws]);

  const handleCancelMatchmaking = useCallback(() => {
    ws.cancelMatchmaking();
    setSelectedHandIds([]);
    setCardIds([]);
    gameStorage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, gameStorage]);

  const handlePackOpenComplete = useCallback(() => {
    // Add newly opened pack cards directly to owned list
    // (notes already imported by useCardPacks; avoid refreshOwnedCards which returns stale notes)
    if (packResult) {
      aztec.updateOwnedCards(prev => [...prev, ...packResult.cardIds]);
    }
    setPackResult(null);
    setScreen('card-packs');
  }, [aztec, packResult]);

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    if (!ws.gameState || !ws.playerNumber || !ws.gameId) return;

    const boardBefore = prevGameStateRef.current?.board ?? ws.gameState.board;
    const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';
    const myHand = ws.playerNumber === 1 ? ws.gameState.player1Hand : ws.gameState.player2Hand;
    const card = myHand[handIndex];

    // Always send the move via WebSocket (server applies it immediately)
    ws.placeCard(handIndex, row, col);

    // Generate move proof in the background (or queue if hand proofs aren't ready yet)
    if (aztec.isAvailable && card) {
      try {
        const { placeCard: applyMove } = await import('@aztec-triple-triad/game-logic');
        const result = applyMove(ws.gameState, myPlayer, handIndex, row, col);
        const boardAfter = result.newState.board;
        const scoresBefore: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];
        const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
        const gameEnded = result.newState.status === 'finished';
        const winnerId = mapWinnerId(result.newState.winner);

        if (gameFlow.myHandProof && gameFlow.opponentHandProof) {
          // Hand proofs ready — generate proof immediately
          const moveProof = await gameFlow.generateMoveProofForPlacement(
            card.id, row, col,
            boardBefore, boardAfter,
            scoresBefore, scoresAfter,
            gameEnded, winnerId,
          );
          if (moveProof) {
            ws.submitMoveProof(ws.gameId, handIndex, row, col, moveProof);
          }
        } else {
          // Hand proofs not ready yet — queue for later
          console.log('[App] Hand proofs not ready, queuing move for deferred proof gen');
          pendingMovesRef.current.push({
            cardId: card.id, handIndex, row, col,
            boardBefore: JSON.parse(JSON.stringify(boardBefore)),
            boardAfter: JSON.parse(JSON.stringify(boardAfter)),
            scoresBefore, scoresAfter, gameEnded, winnerId,
          });
        }
      } catch (err) {
        console.warn('[App] Move proof generation failed, move still sent via WS:', err);
      }
    }
  }, [ws, aztec.isAvailable, gameFlow]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    // Capture all values from current state before any awaits — settlement must
    // survive navigation back to lobby (closures keep these values alive).
    const currentGameId = ws.gameId;
    if (!currentGameId || !gameFlow.myHandProof || !gameFlow.opponentHandProof) {
      console.error('[App] Cannot settle: missing proofs');
      return;
    }

    // Determine on-chain game ID
    const chainGameId = gameContract.onChainGameId ?? ws.opponentOnChainGameId;
    if (!chainGameId) {
      console.error('[App] Cannot settle: no on-chain game ID');
      return;
    }

    // Determine opponent address
    const opponentAddr = ws.opponentAztecAddress;
    if (!opponentAddr) {
      console.error('[App] Cannot settle: no opponent Aztec address');
      return;
    }

    // Get opponent card IDs (from GAME_OVER message)
    const oppCardIds = ws.opponentCardIds;
    if (oppCardIds.length === 0) {
      console.error('[App] Cannot settle: no opponent card IDs available');
      return;
    }

    // Wait for all 9 move proofs if the last one is still generating.
    // The 9th proof (final move) may still be in flight when the user clicks settle.
    // Use moveProofsRef to read the latest value (avoids stale closure).
    if (moveProofsRef.current.length < 9) {
      console.log(`[App] Waiting for move proofs (${moveProofsRef.current.length}/9)...`);
      const deadline = Date.now() + 30_000; // 30s timeout
      while (moveProofsRef.current.length < 9 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (moveProofsRef.current.length < 9) {
        console.error(`[App] Timed out waiting for move proofs (have ${moveProofsRef.current.length}/9)`);
        return;
      }
      console.log('[App] All 9 move proofs collected');
    }

    // Order proofs: handProof1 is always player 1's, handProof2 is always player 2's
    const handProof1 = ws.playerNumber === 1 ? gameFlow.myHandProof : gameFlow.opponentHandProof;
    const handProof2 = ws.playerNumber === 2 ? gameFlow.myHandProof : gameFlow.opponentHandProof;

    console.log('[App] Settling game on-chain:', {
      chainGameId,
      opponentAddr,
      selectedCardId,
      myCardIds: cardIds,
      oppCardIds,
      handProof1Commit: handProof1.cardCommit,
      handProof2Commit: handProof2.cardCommit,
      moveProofCount: moveProofsRef.current.length,
    });

    // Get committed randomness values
    const myRandomness = gameContract.gameRandomness;
    const oppRandomness = ws.opponentGameRandomness;
    if (!myRandomness || myRandomness.length !== 6) {
      console.error('[App] Cannot settle: no caller randomness');
      return;
    }
    if (!oppRandomness || oppRandomness.length !== 6) {
      console.error('[App] Cannot settle: no opponent randomness');
      return;
    }

    const result = await gameContract.settleGame({
      onChainGameId: chainGameId,
      handProof1,
      handProof2,
      moveProofs: moveProofsRef.current,
      opponentAddress: opponentAddr,
      cardToTransfer: selectedCardId,
      callerCardIds: cardIds,
      opponentCardIds: oppCardIds,
      callerRandomness: myRandomness,
      opponentRandomness: oppRandomness,
    });

    if (result) {
      // 1. Relay note data to opponent so they can import their notes.
      //    Uses captured currentGameId — safe even if user navigated away.
      ws.relayNoteData(currentGameId, result.txHash, result.opponentNotes);
      console.log('[App] Relayed', result.opponentNotes.length, 'opponent note(s)');

      // 2. Import winner's own notes — PXE sync won't find them without delivery/tagging
      console.log('[App] Importing', result.callerNotes.length, 'winner note(s)...');
      await importNotesForTx(result.txHash, result.callerNotes, 'Winner import');

      // 3. Wait for PXE to sync past the settlement block so it processes nullifiers.
      //    Without this, stale notes remain "ACTIVE" in the PXE and pop_notes may
      //    select them in the next game, causing "Existing nullifier" errors.
      await waitForPxeSync();
    }
  }, [ws.gameId, ws.playerNumber, ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentCardIds, ws.opponentGameRandomness, gameFlow, gameContract, cardIds, ws, importNotesForTx, waitForPxeSync]);

  const handleBackToMenu = useCallback(() => {
    ws.leaveGame();
    gameFlow.reset();
    gameContract.resetTx();
    gameContract.resetLifecycle();
    setCardIds([]);
    setSelectedHandIds([]);
    gameStorage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, gameFlow, gameContract, gameStorage]);

  const showMenuScene = screen === 'main-menu' || screen === 'card-selector'
    || screen === 'finding-opponent' || screen === 'card-packs' || screen === 'pack-opening';

  return (
    <div className="app">
      <div className="app__bg" />

      {/* Shared 3D swamp backdrop for all pre-game screens */}
      {showMenuScene && <MenuScene />}

      {screen === 'main-menu' && (
        <MainMenu
          connected={ws.connected}
          aztecConnecting={aztec.isConnecting}
          aztecReady={aztec.hasConnected}
          cardCount={aztec.ownedCardIds.length}
          hasGameInProgress={hasGameInProgress}
          onPlay={handlePlay}
          onTutorial={handleTutorial}
          onCardPacks={handleCardPacks}
        />
      )}

      {screen === 'card-selector' && (
        <CardSelector
          ownedCardIds={aztec.ownedCardIds}
          onConfirm={handleHandSelected}
          onBack={() => setScreen('main-menu')}
        />
      )}

      {screen === 'finding-opponent' && (
        <FindingOpponent
          queuePosition={ws.queuePosition}
          onCancel={handleCancelMatchmaking}
        />
      )}

      {screen === 'card-packs' && (
        <CardPacks
          wallet={aztec.wallet}
          accountAddress={aztec.accountAddress}
          ownedCardIds={aztec.ownedCardIds}
          onPackOpened={(location: string, result) => {
            setPackResult({ location, cardIds: result.cardIds });
            setScreen('pack-opening');
          }}
          onBack={() => setScreen('main-menu')}
        />
      )}

      {screen === 'pack-opening' && packResult && (
        <PackOpening
          location={packResult.location}
          cardIds={packResult.cardIds}
          onComplete={handlePackOpenComplete}
        />
      )}

      {screen === 'game' && ws.gameState && ws.playerNumber && ws.gameId && (
        <GameScreen
          gameState={ws.gameState}
          playerNumber={ws.playerNumber}
          gameId={ws.gameId}
          lastCaptures={ws.lastCaptures}
          gameOver={ws.gameOver}
          opponentDisconnected={ws.opponentDisconnected}
          onPlaceCard={handlePlaceCard}
          onBackToLobby={handleBackToMenu}
          aztecStatus={aztec.status}
          proofStatus={{
            hand: gameFlow.handProofStatus,
            move: gameFlow.moveProofStatus,
          }}
          canSettle={gameFlow.canSettle}
          onSettle={handleSettle}
          settleTxStatus={gameContract.txStatus}
        />
      )}
      {screen === 'game' && !ws.gameState && (
        <div className="app__waiting">
          <div className="app__waiting-spinner" />
          <p>Finding opponent...</p>
          <button className="btn btn--ghost" onClick={handleBackToMenu}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
