import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAztec } from './hooks/useAztec';
import { useGameFlow } from './hooks/useGameFlow';
import { useGameContract } from './hooks/useGameContract';
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
  const gameFlow = useGameFlow({
    gameId: ws.gameId,
    playerNumber: ws.playerNumber,
    cardIds,
    gameState: ws.gameState,
    wallet: aztec.wallet,
    accountAddress: aztec.accountAddress,
  });
  const gameContract = useGameContract(aztec.wallet, aztec.accountAddress);

  // Track previous gameState for board-before snapshots
  const prevGameStateRef = useRef<GameState | null>(null);

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

    if (ws.playerNumber === 1) {
      gameContract.createGameOnChain(cardIds).then((chainId) => {
        if (chainId && ws.gameId && aztec.accountAddress) {
          ws.shareAztecInfo(ws.gameId, aztec.accountAddress, chainId);
          console.log('[App] On-chain game created, shared ID:', chainId);
        }
      });
    } else if (ws.playerNumber === 2 && ws.opponentOnChainGameId) {
      gameContract.joinGameOnChain(ws.opponentOnChainGameId, cardIds);
    }
  }, [ws.gameId, ws.gameState, ws.playerNumber, ws.opponentOnChainGameId, gameContract.isAvailable, cardIds, aztec.accountAddress, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 6b. Player 2: join on-chain game when we receive opponent's on-chain game ID later
  useEffect(() => {
    if (ws.playerNumber !== 2 || !ws.opponentOnChainGameId) return;
    if (gameContract.onChainGameId) return; // already joined
    if (!gameContract.isAvailable) return;
    gameContract.joinGameOnChain(ws.opponentOnChainGameId, cardIds);
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
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Filter out zero-valued hashes to get only real note hashes
      const uniqueNoteHashes: string[] = rawNoteHashes
        .map((h: any) => h.toString())
        .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
      const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

      console.log(`[App] ${label}: TxEffect has ${uniqueNoteHashes.length} non-zero note hashes, firstNullifier=${firstNullifier.slice(0, 18)}...`);
      for (let i = 0; i < Math.min(uniqueNoteHashes.length, 12); i++) {
        console.log(`[App] ${label}:   noteHash[${i}] = ${uniqueNoteHashes[i].slice(0, 24)}...`);
      }

      // === DIAGNOSTIC: Compute expected note hashes in TypeScript and compare ===
      const { poseidon2HashWithSeparator } = await import('@aztec/foundation/crypto/poseidon');
      const { siloNoteHash, computeUniqueNoteHash, computeNoteHashNonce } = await import('@aztec/stdlib/hash');
      const { DomainSeparator } = await import('@aztec/constants');

      const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress!);
      const STORAGE_SLOT = new Fr(9n); // private_nfts slot from storage_layout()

      const firstNullFr = Fr.fromHexString(firstNullifier);
      let totalMatches = 0;

      for (const note of notes) {
        const valueFr = new Fr(BigInt(note.tokenId));
        const randomnessFr = Fr.fromHexString(note.randomness);

        // Step 1: Compute raw note hash (same as create_and_push_note in Noir)
        const rawNoteHash = await poseidon2HashWithSeparator(
          [valueFr, myAddr.toField(), STORAGE_SLOT, randomnessFr],
          DomainSeparator.NOTE_HASH,
        );

        // Step 2: Silo by contract address
        const siloedHash = await siloNoteHash(nftAddr, rawNoteHash);

        // Step 3: Try each index to find the matching unique note hash
        let found = false;
        for (let i = 0; i < uniqueNoteHashes.length; i++) {
          const nonce = await computeNoteHashNonce(firstNullFr, i);
          const uniqueHash = await computeUniqueNoteHash(nonce, siloedHash);
          if (uniqueHash.toString() === uniqueNoteHashes[i]) {
            console.log(`[App] ${label}: MATCH tokenId=${note.tokenId} at index ${i}`);
            found = true;
            totalMatches++;
            break;
          }
        }
        if (!found) {
          console.error(`[App] ${label}: NO MATCH for tokenId=${note.tokenId}`);
          console.error(`  rawNoteHash = ${rawNoteHash.toString().slice(0, 24)}...`);
          console.error(`  siloedHash  = ${siloedHash.toString().slice(0, 24)}...`);
          console.error(`  owner       = ${myAddr.toString()}`);
          console.error(`  randomness  = ${note.randomness.slice(0, 24)}...`);
        }
      }
      console.log(`[App] ${label}: ${totalMatches}/${notes.length} notes matched TxEffect hashes`);
      // === END DIAGNOSTIC ===

      // Load NFT contract
      const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
      if (!resp.ok) throw new Error('Failed to load NFT contract artifact');
      const artifact = loadContractArtifact(await resp.json());
      const nftContract = await Contract.at(nftAddr, artifact, aztec.wallet as never);

      // Import each note via import_note utility function
      for (const note of notes) {
        // Pad unique_note_hashes to 64-element array
        const paddedHashes = new Array(64).fill(new Fr(0n));
        for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
          paddedHashes[i] = Fr.fromHexString(uniqueNoteHashes[i]);
        }

        console.log(`[App] ${label}: importing note tokenId=${note.tokenId} randomness=${note.randomness.slice(0, 18)}...`);
        await nftContract.methods
          .import_note(
            myAddr,
            new Fr(BigInt(note.tokenId)),
            Fr.fromHexString(note.randomness),
            Fr.fromHexString(txHashStr),
            paddedHashes,
            uniqueNoteHashes.length,
            Fr.fromHexString(firstNullifier),
            myAddr,
          )
          .simulate({ from: myAddr });
      }

      console.log(`[App] ${label}: Imported ${notes.length} notes successfully`);
      aztec.refreshOwnedCards();
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
    importNotesForTx(txHash, notes, 'Loser import');
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, importNotesForTx]);

  const handlePlay = useCallback(() => {
    aztec.refreshOwnedCards();
    setScreen('card-selector');
  }, [aztec]);

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
    setScreen('main-menu');
  }, [ws]);

  const handlePackOpenComplete = useCallback(() => {
    setPackResult(null);
    aztec.refreshOwnedCards();
    setScreen('card-packs');
  }, [aztec]);

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
      moveProofCount: gameFlow.collectedMoveProofs.length,
    });

    const result = await gameContract.settleGame({
      onChainGameId: chainGameId,
      handProof1,
      handProof2,
      moveProofs: gameFlow.collectedMoveProofs,
      opponentAddress: opponentAddr,
      cardToTransfer: selectedCardId,
      callerCardIds: cardIds,
      opponentCardIds: oppCardIds,
    });

    if (result) {
      // 1. Relay note data to opponent so they can import their notes.
      //    Uses captured currentGameId — safe even if user navigated away.
      ws.relayNoteData(currentGameId, result.txHash, result.opponentNotes);
      console.log('[App] Relayed', result.opponentNotes.length, 'opponent note(s)');

      // 2. Import winner's own notes — PXE sync won't find them without delivery/tagging
      console.log('[App] Importing', result.callerNotes.length, 'winner note(s)...');
      await importNotesForTx(result.txHash, result.callerNotes, 'Winner import');
    }
  }, [ws.gameId, ws.playerNumber, ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentCardIds, gameFlow, gameContract, cardIds, ws, importNotesForTx]);

  const handleBackToMenu = useCallback(() => {
    ws.leaveGame();
    gameFlow.reset();
    gameContract.resetTx();
    gameContract.resetLifecycle();
    setCardIds([]);
    setSelectedHandIds([]);
    setScreen('main-menu');
  }, [ws, gameFlow, gameContract]);

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
          onPackOpened={(location: string, newCardIds: number[]) => {
            setPackResult({ location, cardIds: newCardIds });
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
