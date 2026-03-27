import { useState, useRef, useEffect, useCallback } from 'react';
import type { GameState, Player } from '../types';
import { createGame, placeCard } from '@axolotl-arena/game-logic';
import { PLAYER_TUTORIAL_HAND, XOCHITL_TUTORIAL_HAND, TIMMY_TUTORIAL_HAND } from './tutorialCards';
import { TUTORIAL_SCENES, TIMMY_SCENES } from './tutorialScript';
import type { HighlightTarget, TutorialScene, TriggerKind } from './tutorialScript';

export type TutorialResult = 'player_win' | 'xochitl_win' | 'draw' | null;
export type TutorialPhase = 'xochitl' | 'transition' | 'timmy' | 'starter-pack';

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
  phase: TutorialPhase;
  /** Which of opponent's hand cards are revealed face-up */
  xochitlRevealCount: number;
  /** Tutorial pulse hand card index (for highlighting) */
  tutorialPulseHandIndex: number | null;
  /** Tutorial highlight cells */
  tutorialHighlightCells: { row: number; col: number }[];
  handlePlaceCard: (handIndex: number, row: number, col: number) => void;
  handleContinue: () => void;
  handleSkipTypewriter: () => void;
  handleAdvanceDialogue: () => void;
  handleSelectWinCard: (cardId: number) => void;
  handleSkip: () => void;
  handlePlayAgain: () => void;
  handleExitToMenu: () => void;
  handleStartTimmy: () => void;
}

const TYPEWRITER_MS = 35;

function initGameState(phase: TutorialPhase): GameState {
  const opponentHand = phase === 'timmy' ? TIMMY_TUTORIAL_HAND : XOCHITL_TUTORIAL_HAND;
  const gs = createGame(
    PLAYER_TUTORIAL_HAND.map(c => ({ ...c, ranks: { ...c.ranks } })),
    opponentHand.map(c => ({ ...c, ranks: { ...c.ranks } })),
  );
  // Opponent goes first in both phases
  return { ...gs, currentTurn: 'player2' };
}

function getScenesForPhase(phase: TutorialPhase): TutorialScene[] {
  return phase === 'timmy' ? TIMMY_SCENES : TUTORIAL_SCENES;
}

/** Simple AI: pick first empty cell, scanning left-to-right top-to-bottom */
function pickCpuCell(gs: GameState): { row: number; col: number } | null {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (!gs.board[r][c].card) return { row: r, col: c };
    }
  }
  return null;
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
  const [phase, setPhase] = useState<TutorialPhase>('xochitl');

  const scenes = getScenesForPhase(phase);

  // Keep a ref to game state to avoid stale closures in setTimeout callbacks
  const gameStateRef = useRef<GameState | null>(null);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  // Stable refs for callbacks used inside advanceDialogueLine's setTimeouts
  const checkTriggersRef = useRef<(event: TriggerKind, gs: GameState, row?: number, col?: number) => void>(() => {});
  const handleGameEndRef = useRef<(gs: GameState) => void>(() => {});

  // Typewriter refs to allow cancellation
  const typewriterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cpuMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentScene = sceneIndex >= 0 && sceneIndex < scenes.length ? scenes[sceneIndex] : null;

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
    if (!handHighlight || !gameState) return null;
    return gameState.player1Hand.findIndex(c => c.id === handHighlight.cardId);
  })();

  const xochitlRevealCount: number = (() => {
    const oppHighlight = currentHighlights.find(h => h.kind === 'OPPONENT_HAND') as
      Extract<HighlightTarget, { kind: 'OPPONENT_HAND' }> | undefined;
    if (oppHighlight) return oppHighlight.revealCount;
    // Default: Xochitl shows all 5, Timmy shows 3 (Old Boot + Lost Cat hidden)
    return phase === 'timmy' ? 3 : 5;
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
        setShowContinueButton(false);
      } else if (!scene.allowPlayerAction) {
        setShowContinueButton(true);
      } else {
        setShowContinueButton(false);
      }

      // Schedule CPU move (fixed-position or AI-picked)
      const move = scene.xochitlMoveAfter ?? null;
      const autoMove = scene.cpuAutoMove ?? null;
      if (move || autoMove) {
        const delay = scene.xochitlMoveDelayMs ?? 800;
        cpuMoveTimerRef.current = setTimeout(() => {
          const gs = gameStateRef.current;
          if (!gs) return;

          let cardId: number;
          let row: number;
          let col: number;

          if (move) {
            // Fixed-position move (Xochitl phase 1)
            cardId = move.cardId;
            row = move.row;
            col = move.col;
          } else {
            // AI-picked cell (Timmy phase 2)
            cardId = autoMove!.cardId;
            const cell = pickCpuCell(gs);
            if (!cell) return;
            row = cell.row;
            col = cell.col;
          }

          const handIndex = gs.player2Hand.findIndex(c => c.id === cardId);
          if (handIndex < 0) return;

          const result = placeCard(gs, 'player2', handIndex, row, col);
          if (!result) return;

          gameStateRef.current = result.newState;
          setGameState(result.newState);
          setLastCaptures(result.captures);

          if (result.newState.status === 'finished') {
            handleGameEndRef.current(result.newState);
          } else {
            checkTriggersRef.current({ kind: 'TURN_START' }, result.newState);
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

  const enterScene = useCallback((index: number, sceneList?: TutorialScene[]) => {
    const list = sceneList ?? scenes;
    if (index >= list.length) return;
    const scene = list[index];
    setSceneIndex(index);
    setDialogueLineIndex(0);
    setShowContinueButton(false);
    advanceDialogueLine(scene, 0);
  }, [advanceDialogueLine, scenes]);

  // ── Game end handling ─────────────────────────────────────────────────

  const handleGameEnd = useCallback((gs: GameState) => {
    let result: TutorialResult;
    if (gs.winner === 'player1') result = 'player_win';
    else if (gs.winner === 'player2') result = 'xochitl_win';
    else result = 'draw';

    setTutorialResult(result);
    setGameOver({ winner: gs.winner ?? 'draw' });
  }, []);
  useEffect(() => { handleGameEndRef.current = handleGameEnd; }, [handleGameEnd]);

  // ── Trigger checking ──────────────────────────────────────────────────

  const checkTriggers = useCallback((
    event: TriggerKind,
    gs: GameState,
    row?: number,
    col?: number,
  ) => {
    const filledCount = gs.board.flat().filter(cell => cell.card !== null).length;

    for (let i = sceneIndex + 1; i < scenes.length; i++) {
      const scene = scenes[i];
      const t = scene.trigger;

      let matches = false;
      if (t.kind === event.kind) {
        if (t.kind === 'CELLS_FILLED' && event.kind === 'CELLS_FILLED') {
          matches = filledCount >= t.count;
        } else if (t.kind === 'CARD_PLACED' && event.kind === 'ANY_CARD_PLACED') {
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
  }, [sceneIndex, scenes, enterScene]);
  useEffect(() => { checkTriggersRef.current = checkTriggers; }, [checkTriggers]);

  const handleAdvanceDialogue = useCallback(() => {
    if (!currentScene) return;
    if (isTyping) {
      stopTypewriter();
      const line = currentScene.dialogue[dialogueLineIndex];
      if (line) {
        setDisplayedText(line.text);
        setIsTyping(false);
      }
      if (dialogueLineIndex + 1 >= currentScene.dialogue.length) {
        advanceDialogueLine(currentScene, dialogueLineIndex + 1);
      }
      return;
    }
    stopTypewriter();
    const nextIdx = dialogueLineIndex + 1;
    if (nextIdx < currentScene.dialogue.length) {
      setDialogueLineIndex(nextIdx);
      advanceDialogueLine(currentScene, nextIdx);
    } else if (showContinueButton) {
      setShowContinueButton(false);
      checkTriggers({ kind: 'CONTINUE_BUTTON' }, gameStateRef.current ?? initGameState(phase));
    }
  }, [isTyping, currentScene, dialogueLineIndex, showContinueButton, stopTypewriter, advanceDialogueLine, checkTriggers, phase]);

  // ── Start / restart helpers ─────────────────────────────────────────────

  const startPhase = useCallback((p: TutorialPhase) => {
    stopTypewriter();
    if (cpuMoveTimerRef.current) clearTimeout(cpuMoveTimerRef.current);
    const gs = initGameState(p);
    setPhase(p);
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
    setLastCaptures([]);
    const sceneList = getScenesForPhase(p);
    setTimeout(() => enterScene(0, sceneList), 800);
  }, [stopTypewriter, enterScene]);

  // ── Initial mount ──────────────────────────────────────────────────────

  useEffect(() => {
    const gs = initGameState('xochitl');
    setGameState(gs);
    gameStateRef.current = gs;
    setSceneIndex(-1);
    setIsComplete(false);
    setGameOver(null);
    setTutorialResult(null);
    setWinCardSelected(false);
    const id = setTimeout(() => {
      enterScene(0);
    }, 800);
    return () => {
      clearTimeout(id);
      stopTypewriter();
      if (cpuMoveTimerRef.current) clearTimeout(cpuMoveTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Player actions ────────────────────────────────────────────────────

  const handlePlaceCard = useCallback((handIndex: number, row: number, col: number) => {
    const gs = gameStateRef.current;
    if (!gs || gs.currentTurn !== 'player1') return;
    if (!currentScene?.allowPlayerAction) return;

    // Phase 1 (Xochitl): enforce card + cell restrictions
    if (phase === 'xochitl') {
      if (tutorialPulseHandIndex !== null && handIndex !== tutorialPulseHandIndex) return;
      if (tutorialHighlightCells.length > 0 &&
          !tutorialHighlightCells.some(c => c.row === row && c.col === col)) return;
    }

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
  }, [currentScene, phase, tutorialPulseHandIndex, tutorialHighlightCells, checkTriggers, handleGameEnd]);

  const handleContinue = useCallback(() => {
    if (!showContinueButton) return;
    setShowContinueButton(false);
    checkTriggers({ kind: 'CONTINUE_BUTTON' }, gameStateRef.current ?? initGameState(phase));
  }, [showContinueButton, checkTriggers, phase]);

  const handleSelectWinCard = useCallback((_cardId: number) => {
    setWinCardSelected(true);
    if (phase === 'xochitl') {
      // Phase 1 done — show transition choice
      setPhase('transition');
    } else {
      setIsComplete(true);
    }
  }, [phase]);

  const handleStartTimmy = useCallback(() => {
    startPhase('timmy');
  }, [startPhase]);

  const handleSkip = useCallback(() => {
    stopTypewriter();
    if (cpuMoveTimerRef.current) clearTimeout(cpuMoveTimerRef.current);
    localStorage.setItem('tutorial_completed', 'true');
    setPhase('starter-pack');
  }, [stopTypewriter]);

  const handlePlayAgain = useCallback(() => {
    startPhase(phase === 'timmy' ? 'timmy' : 'xochitl');
  }, [startPhase, phase]);

  const handleExitToMenu = useCallback(() => {
    localStorage.setItem('tutorial_completed', 'true');
    setPhase('starter-pack');
  }, []);

  // Suppress unused warning
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
    phase,
    xochitlRevealCount,
    tutorialPulseHandIndex,
    tutorialHighlightCells,
    handlePlaceCard,
    handleContinue,
    handleSkipTypewriter,
    handleAdvanceDialogue,
    handleSelectWinCard,
    handleSkip,
    handlePlayAgain,
    handleExitToMenu,
    handleStartTimmy,
  };
}
