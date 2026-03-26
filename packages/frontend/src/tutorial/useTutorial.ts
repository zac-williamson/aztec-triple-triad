import { useState, useRef, useEffect, useCallback } from 'react';
import type { GameState, Player } from '../types';
import { createGame, placeCard } from '@axolotl-arena/game-logic';
import { PLAYER_TUTORIAL_HAND, XOCHITL_TUTORIAL_HAND } from './tutorialCards';
import { TUTORIAL_SCENES } from './tutorialScript';
import type { HighlightTarget, TutorialScene, TriggerKind } from './tutorialScript';

export type TutorialResult = 'player_win' | 'xochitl_win' | 'draw' | null;

export interface TutorialState {
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameOver: { winner: Player | 'draw' } | null;
  currentScene: TutorialScene | null;
  displayedText: string;
  isTyping: boolean;
  currentHighlights: HighlightTarget[];
  showContinueButton: boolean;
  tutorialResult: TutorialResult;
  isComplete: boolean;
  /** Which of Xochitl's hand cards are revealed face-up */
  xochitlRevealCount: number;
  /** Tutorial pulse hand card index (for highlighting) */
  tutorialPulseHandIndex: number | null;
  /** Tutorial highlight cells */
  tutorialHighlightCells: { row: number; col: number }[];
  handlePlaceCard: (handIndex: number, row: number, col: number) => void;
  handleContinue: () => void;
  handleSkipTypewriter: () => void;
  handleSelectWinCard: (cardId: number) => void;
  handleSkip: () => void;
  handlePlayAgain: () => void;
  handleExitToMenu: () => void;
}

const TYPEWRITER_MS = 35;

function initGameState(): GameState {
  return createGame(
    PLAYER_TUTORIAL_HAND.map(c => ({ ...c, ranks: { ...c.ranks } })),
    XOCHITL_TUTORIAL_HAND.map(c => ({ ...c, ranks: { ...c.ranks } })),
  );
}

export function useTutorial(onExit: () => void): TutorialState {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastCaptures, setLastCaptures] = useState<{ row: number; col: number }[]>([]);
  const [gameOver, setGameOver] = useState<{ winner: Player | 'draw' } | null>(null);
  const [sceneIndex, setSceneIndex] = useState(-1);
  const [dialogueLineIndex, setDialogueLineIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showContinueButton, setShowContinueButton] = useState(false);
  const [tutorialResult, setTutorialResult] = useState<TutorialResult>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [winCardSelected, setWinCardSelected] = useState(false);

  // Keep a ref to game state to avoid stale closures in setTimeout callbacks
  const gameStateRef = useRef<GameState | null>(null);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  // Typewriter refs to allow cancellation
  const typewriterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xochitlMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentScene = sceneIndex >= 0 ? TUTORIAL_SCENES[sceneIndex] : null;

  // Derive highlights from current scene
  const currentHighlights: HighlightTarget[] = currentScene?.highlights ?? [];

  const tutorialHighlightCells: { row: number; col: number }[] = currentHighlights
    .filter(h => h.kind === 'BOARD_CELL')
    .map(h => {
      const bh = h as Extract<HighlightTarget, { kind: 'BOARD_CELL' }>;
      return { row: bh.row, col: bh.col };
    });

  const tutorialPulseHandIndex: number | null = (() => {
    const handHighlight = currentHighlights.find(h => h.kind === 'HAND_CARD') as
      Extract<HighlightTarget, { kind: 'HAND_CARD' }> | undefined;
    return handHighlight ? handHighlight.index : null;
  })();

  const xochitlRevealCount: number = (() => {
    const oppHighlight = currentHighlights.find(h => h.kind === 'OPPONENT_HAND') as
      Extract<HighlightTarget, { kind: 'OPPONENT_HAND' }> | undefined;
    return oppHighlight ? oppHighlight.revealCount : 5;
  })();

  // ── Typewriter ─────────────────────────────────────────────────────────

  const stopTypewriter = useCallback(() => {
    if (typewriterTimerRef.current) {
      clearTimeout(typewriterTimerRef.current);
      typewriterTimerRef.current = null;
    }
  }, []);

  const runTypewriter = useCallback((
    text: string,
    onDone: () => void,
  ) => {
    stopTypewriter();
    setIsTyping(true);
    setDisplayedText('');

    let i = 0;
    const tick = () => {
      i++;
      setDisplayedText(text.slice(0, i));
      if (i < text.length) {
        typewriterTimerRef.current = setTimeout(tick, TYPEWRITER_MS);
      } else {
        setIsTyping(false);
        onDone();
      }
    };
    typewriterTimerRef.current = setTimeout(tick, TYPEWRITER_MS);
  }, [stopTypewriter]);

  const handleSkipTypewriter = useCallback(() => {
    if (!isTyping || !currentScene) return;
    stopTypewriter();
    const line = currentScene.dialogue[dialogueLineIndex];
    if (line) {
      setDisplayedText(line.text);
      setIsTyping(false);
    }
  }, [isTyping, currentScene, dialogueLineIndex, stopTypewriter]);

  // ── Scene advancement ─────────────────────────────────────────────────

  const advanceDialogueLine = useCallback((scene: TutorialScene, lineIdx: number) => {
    if (lineIdx >= scene.dialogue.length) {
      // All lines done
      if (scene.autoAdvance) {
        // Scenes with autoAdvance don't need a Continue button — they wait for triggers
        setShowContinueButton(false);
      } else if (!scene.allowPlayerAction) {
        setShowContinueButton(true);
      } else {
        setShowContinueButton(false);
      }

      // Schedule Xochitl's move if applicable
      if (scene.xochitlMoveAfter) {
        const delay = scene.xochitlMoveDelayMs ?? 800;
        xochitlMoveTimerRef.current = setTimeout(() => {
          const gs = gameStateRef.current;
          if (!gs) return;

          const move = scene.xochitlMoveAfter!;
          const handIndex = gs.player2Hand.findIndex(c => c.id === move.cardId);
          if (handIndex < 0) return;

          const result = placeCard(gs, 'player2', handIndex, move.row, move.col);
          if (!result) return;

          gameStateRef.current = result.newState;
          setGameState(result.newState);
          setLastCaptures(result.captures);

          if (result.newState.status === 'finished') {
            handleGameEnd(result.newState);
          } else {
            // Fire TURN_START trigger (now player's turn)
            checkTriggers({ kind: 'TURN_START' }, result.newState);
          }
        }, delay);
      }

      return;
    }

    const line = scene.dialogue[lineIdx];
    const pauseAfter = line.pauseAfterMs ?? 0;
    runTypewriter(line.text, () => {
      if (pauseAfter > 0) {
        typewriterTimerRef.current = setTimeout(() => {
          advanceDialogueLine(scene, lineIdx + 1);
        }, pauseAfter);
      } else {
        // For non-last lines with no explicit continue, auto-advance after 600ms
        if (lineIdx + 1 < scene.dialogue.length) {
          typewriterTimerRef.current = setTimeout(() => {
            setDialogueLineIndex(lineIdx + 1);
            advanceDialogueLine(scene, lineIdx + 1);
          }, 700);
        } else {
          advanceDialogueLine(scene, lineIdx + 1);
        }
      }
    });
  }, [runTypewriter]); // eslint-disable-line react-hooks/exhaustive-deps

  const enterScene = useCallback((index: number) => {
    if (index >= TUTORIAL_SCENES.length) return;
    const scene = TUTORIAL_SCENES[index];
    setSceneIndex(index);
    setDialogueLineIndex(0);
    setShowContinueButton(false);
    advanceDialogueLine(scene, 0);
  }, [advanceDialogueLine]);

  // ── Game end handling ─────────────────────────────────────────────────

  const handleGameEnd = useCallback((gs: GameState) => {
    let result: TutorialResult;
    if (gs.winner === 'player1') result = 'player_win';
    else if (gs.winner === 'player2') result = 'xochitl_win';
    else result = 'draw';

    setTutorialResult(result);
    setGameOver({ winner: gs.winner ?? 'draw' });

    if (result === 'xochitl_win') {
      // Auto-pick the player's weakest board card
      // (lowest sum of ranks among player1's original board cards)
    }
  }, []);

  // ── Trigger checking ──────────────────────────────────────────────────

  const checkTriggers = useCallback((
    event: TriggerKind,
    gs: GameState,
    row?: number,
    col?: number,
  ) => {
    const filledCount = gs.board.flat().filter(cell => cell.card !== null).length;

    for (let i = sceneIndex + 1; i < TUTORIAL_SCENES.length; i++) {
      const scene = TUTORIAL_SCENES[i];
      const t = scene.trigger;

      let matches = false;
      if (t.kind === event.kind) {
        if (t.kind === 'CELLS_FILLED' && event.kind === 'CELLS_FILLED') {
          matches = filledCount >= t.count;
        } else if (t.kind === 'CARD_PLACED' && event.kind === 'ANY_CARD_PLACED') {
          // Never match CARD_PLACED with ANY_CARD_PLACED shortcut
          matches = false;
        } else {
          matches = true;
        }
      } else if (event.kind === 'ANY_CARD_PLACED') {
        if (t.kind === 'ANY_CARD_PLACED') matches = true;
        if (t.kind === 'CELLS_FILLED' && filledCount >= t.count) matches = true;
        if (t.kind === 'CARD_PLACED' && row !== undefined && col !== undefined &&
            t.row === row && t.col === col) matches = true;
      }

      if (matches) {
        enterScene(i);
        return;
      }
    }
  }, [sceneIndex, enterScene]);

  // ── Start tutorial ────────────────────────────────────────────────────

  useEffect(() => {
    const gs = initGameState();
    setGameState(gs);
    gameStateRef.current = gs;
    setSceneIndex(-1);
    setIsComplete(false);
    setGameOver(null);
    setTutorialResult(null);
    setWinCardSelected(false);
    // Trigger first scene after a short delay to let 3D scene mount
    const id = setTimeout(() => {
      enterScene(0);
    }, 800);
    return () => {
      clearTimeout(id);
      stopTypewriter();
      if (xochitlMoveTimerRef.current) clearTimeout(xochitlMoveTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Player actions ────────────────────────────────────────────────────

  const handlePlaceCard = useCallback((handIndex: number, row: number, col: number) => {
    const gs = gameStateRef.current;
    if (!gs || gs.currentTurn !== 'player1') return;
    if (!currentScene?.allowPlayerAction) return;

    const result = placeCard(gs, 'player1', handIndex, row, col);
    if (!result) return;

    gameStateRef.current = result.newState;
    setGameState(result.newState);
    setLastCaptures(result.captures);

    if (result.newState.status === 'finished') {
      handleGameEnd(result.newState);
      return;
    }

    checkTriggers({ kind: 'ANY_CARD_PLACED' }, result.newState, row, col);
  }, [currentScene, checkTriggers, handleGameEnd]);

  const handleContinue = useCallback(() => {
    if (!showContinueButton) return;
    setShowContinueButton(false);
    checkTriggers({ kind: 'CONTINUE_BUTTON' }, gameStateRef.current ?? initGameState());
  }, [showContinueButton, checkTriggers]);

  const handleSelectWinCard = useCallback((_cardId: number) => {
    setWinCardSelected(true);
    setIsComplete(true);
  }, []);

  const handleSkip = useCallback(() => {
    stopTypewriter();
    if (xochitlMoveTimerRef.current) clearTimeout(xochitlMoveTimerRef.current);
    localStorage.setItem('tutorial_completed', 'true');
    onExit();
  }, [stopTypewriter, onExit]);

  const handlePlayAgain = useCallback(() => {
    stopTypewriter();
    if (xochitlMoveTimerRef.current) clearTimeout(xochitlMoveTimerRef.current);
    // Re-initialise
    const gs = initGameState();
    setGameState(gs);
    gameStateRef.current = gs;
    setSceneIndex(-1);
    setIsComplete(false);
    setGameOver(null);
    setTutorialResult(null);
    setWinCardSelected(false);
    setDisplayedText('');
    setIsTyping(false);
    setShowContinueButton(false);
    setTimeout(() => enterScene(0), 800);
  }, [stopTypewriter, enterScene]);

  const handleExitToMenu = useCallback(() => {
    localStorage.setItem('tutorial_completed', 'true');
    onExit();
  }, [onExit]);

  // Suppress unused warning — winCardSelected used for future UI gating
  void winCardSelected;

  return {
    gameState,
    lastCaptures,
    gameOver,
    currentScene,
    displayedText,
    isTyping,
    currentHighlights,
    showContinueButton,
    tutorialResult,
    isComplete,
    xochitlRevealCount,
    tutorialPulseHandIndex,
    tutorialHighlightCells,
    handlePlaceCard,
    handleContinue,
    handleSkipTypewriter,
    handleSelectWinCard,
    handleSkip,
    handlePlayAgain,
    handleExitToMenu,
  };
}
