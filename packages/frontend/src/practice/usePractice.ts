import { useState, useRef, useCallback, useEffect } from 'react';
import type { GameState, Player, Card } from '../types';
import {
  createGame,
  placeCard,
  chooseBotMove,
  createSeededRng,
  CARD_DATABASE,
  type BotDifficulty,
} from '@axolotl-arena/game-logic';

export type { BotDifficulty };

/**
 * Unscripted practice mode — the tutorial's local game loop (createGame +
 * placeCard against a CPU) generalized to a full game with no script, no
 * chain, and no backend. The opponent is `chooseBotMove` from game-logic at
 * one of three difficulty tiers.
 *
 * The human is player1 and always moves first; the bot is player2 and moves
 * automatically after a short delay (so the human sees their card land).
 */

export type PracticeResult = 'win' | 'loss' | 'draw' | null;

export interface UsePracticeOptions {
  /**
   * Fixed seed for reproducible bot play AND hand dealing. Same seed +
   * difficulty → identical game every time (tests, harness parity). Omitted:
   * hands and bot tiebreaks use Math.random.
   */
  seed?: number;
  /** Delay before the bot plays its move, in ms (UX pacing). Tests pass 0. */
  botDelayMs?: number;
}

export interface PracticeState {
  // Pre-game difficulty selection
  difficulty: BotDifficulty;
  setDifficulty: (d: BotDifficulty) => void;
  started: boolean;

  // Live game
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameOver: { winner: Player | 'draw' } | null;
  result: PracticeResult;
  playerScore: number;
  botScore: number;
  /** True while the bot's move is pending — the board is locked to the human. */
  isBotThinking: boolean;

  // Actions
  start: () => void;
  handlePlaceCard: (handIndex: number, row: number, col: number) => void;
  playAgain: () => void;
  changeDifficulty: () => void;
}

const DEFAULT_BOT_DELAY_MS = 650;
const HUMAN: Player = 'player1';
const BOT: Player = 'player2';
const HAND_SIZE = 5;

/** Deal two distinct 5-card hands from the card database using `rng`. */
function dealHands(rng: () => number): { player: Card[]; bot: Card[] } {
  const pool = [...CARD_DATABASE];
  const picked: Card[] = [];
  const total = HAND_SIZE * 2;
  for (let i = 0; i < total && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return { player: picked.slice(0, HAND_SIZE), bot: picked.slice(HAND_SIZE, total) };
}

export function usePractice(opts: UsePracticeOptions = {}): PracticeState {
  const botDelayMs = opts.botDelayMs ?? DEFAULT_BOT_DELAY_MS;

  const [difficulty, setDifficulty] = useState<BotDifficulty>('greedy');
  const [started, setStarted] = useState(false);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastCaptures, setLastCaptures] = useState<{ row: number; col: number }[]>([]);
  const [gameOver, setGameOver] = useState<{ winner: Player | 'draw' } | null>(null);
  const [isBotThinking, setIsBotThinking] = useState(false);

  // Refs read by the deferred bot-move callback (avoids stale closures).
  const gameStateRef = useRef<GameState | null>(null);
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;
  const botTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-move offset so a seeded game's successive bot tiebreaks differ yet
  // stay reproducible (chooseBotMove rebuilds its rng from the seed each call).
  const moveCountRef = useRef(0);

  const setGame = useCallback((gs: GameState) => {
    gameStateRef.current = gs;
    setGameState(gs);
  }, []);

  const botSeed = (): number | undefined =>
    opts.seed === undefined ? undefined : opts.seed + moveCountRef.current;

  // Schedule the bot's move. Reads difficulty/state via refs so the timer
  // callback is never stale.
  const runBotMove = useCallback(() => {
    const gs = gameStateRef.current;
    if (!gs || gs.currentTurn !== BOT || gs.status !== 'playing') return;
    setIsBotThinking(true);
    botTimerRef.current = setTimeout(() => {
      botTimerRef.current = null;
      const cur = gameStateRef.current;
      if (!cur || cur.currentTurn !== BOT || cur.status !== 'playing') {
        setIsBotThinking(false);
        return;
      }
      const move = chooseBotMove(cur, { difficulty: difficultyRef.current, seed: botSeed() });
      moveCountRef.current++;
      const result = placeCard(cur, BOT, move.handIndex, move.row, move.col);
      setIsBotThinking(false);
      setGame(result.newState);
      setLastCaptures(result.captures);
      if (result.newState.status === 'finished') {
        setGameOver({ winner: result.newState.winner ?? 'draw' });
      }
    }, botDelayMs);
  }, [botDelayMs, setGame]); // opts.seed/difficulty read via closure/refs

  const beginGame = useCallback(() => {
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
    const rng = opts.seed === undefined ? Math.random : createSeededRng(opts.seed);
    const { player, bot } = dealHands(rng);
    const gs = createGame(player, bot); // createGame defaults currentTurn to player1
    moveCountRef.current = 0;
    setGame(gs);
    setLastCaptures([]);
    setGameOver(null);
    setIsBotThinking(false);
    setStarted(true);
  }, [opts.seed, setGame]);

  const start = useCallback(() => { beginGame(); }, [beginGame]);
  const playAgain = useCallback(() => { beginGame(); }, [beginGame]);

  const changeDifficulty = useCallback(() => {
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
    setStarted(false);
    gameStateRef.current = null;
    setGameState(null);
    setLastCaptures([]);
    setGameOver(null);
    setIsBotThinking(false);
  }, []);

  const handlePlaceCard = useCallback((handIndex: number, row: number, col: number) => {
    const gs = gameStateRef.current;
    // Preconditions guarantee placeCard (which THROWS on an illegal move)
    // always succeeds: it must be the human's turn, the game in progress, and
    // the bot not mid-move.
    if (!gs || gs.currentTurn !== HUMAN || gs.status !== 'playing' || isBotThinking) return;

    const result = placeCard(gs, HUMAN, handIndex, row, col);
    moveCountRef.current++;
    setGame(result.newState);
    setLastCaptures(result.captures);

    if (result.newState.status === 'finished') {
      setGameOver({ winner: result.newState.winner ?? 'draw' });
      return;
    }
    if (result.newState.currentTurn === BOT) runBotMove();
  }, [isBotThinking, runBotMove, setGame]);

  // Clear any pending bot timer on unmount.
  useEffect(() => () => {
    if (botTimerRef.current) clearTimeout(botTimerRef.current);
  }, []);

  const result: PracticeResult = !gameOver
    ? null
    : gameOver.winner === HUMAN ? 'win'
    : gameOver.winner === BOT ? 'loss'
    : 'draw';

  return {
    difficulty,
    setDifficulty,
    started,
    gameState,
    lastCaptures,
    gameOver,
    result,
    playerScore: gameState?.player1Score ?? HAND_SIZE,
    botScore: gameState?.player2Score ?? HAND_SIZE,
    isBotThinking,
    start,
    handlePlaceCard,
    playAgain,
    changeDifficulty,
  };
}
