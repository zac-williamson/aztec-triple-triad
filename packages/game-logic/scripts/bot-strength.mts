/**
 * How strong is the bot, actually?
 *
 * There are no real players yet, so the win rate that governs the card economy
 * cannot be observed — and "is the bot any good" has never been tested at all.
 * Both are answerable without players: the rules engine is pure, so thousands
 * of games run in seconds with no proving.
 *
 * Measures every difficulty against every other, alternating who moves first
 * (player 1 places five cards to player 2's four, so seat matters), with random
 * hands drawn fresh per game.
 *
 *   npx tsx packages/game-logic/scripts/bot-strength.mts [games-per-pairing]
 */
import { CARD_DATABASE, createGame, placeCard, isGameOver, calculateScores, chooseBotMove } from '../src/index.js';
import type { BotDifficulty, GameState, Player } from '../src/index.js';

const GAMES = Number(process.argv[2] ?? 400);
const LEVELS: BotDifficulty[] = ['random', 'greedy', 'lookahead'];

function randomHand(rng: () => number) {
  return Array.from({ length: 5 }, () => CARD_DATABASE[Math.floor(rng() * CARD_DATABASE.length)]);
}

/** One game. Returns the winner, or 'draw'. */
function play(p1: BotDifficulty, p2: BotDifficulty, rng: () => number): Player | 'draw' {
  let state: GameState = createGame(randomHand(rng), randomHand(rng));
  while (!isGameOver(state)) {
    const who = state.currentTurn;
    const move = chooseBotMove(state, { difficulty: who === 'player1' ? p1 : p2 });
    state = placeCard(state, who, move.handIndex, move.row, move.col).newState;
  }
  const { player1, player2 } = calculateScores(state);
  return player1 === player2 ? 'draw' : player1 > player2 ? 'player1' : 'player2';
}

/** A vs B over `games`, split evenly between seats so the result is seat-neutral. */
function match(a: BotDifficulty, b: BotDifficulty, games: number) {
  let aWins = 0, bWins = 0, draws = 0;
  const rng = Math.random;
  for (let i = 0; i < games; i++) {
    const aIsFirst = i % 2 === 0;
    const r = aIsFirst ? play(a, b, rng) : play(b, a, rng);
    if (r === 'draw') draws++;
    else if ((r === 'player1') === aIsFirst) aWins++;
    else bWins++;
  }
  return { aWins, bWins, draws };
}

/** First-player advantage, measured by playing a level against itself. */
function seatBias(level: BotDifficulty, games: number) {
  let p1 = 0, p2 = 0, draws = 0;
  for (let i = 0; i < games; i++) {
    const r = play(level, level, Math.random);
    if (r === 'draw') draws++; else if (r === 'player1') p1++; else p2++;
  }
  return { p1, p2, draws };
}

const pct = (n: number, total: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log(`\n  Bot strength — ${GAMES} games per pairing, seats alternated\n`);
console.log(`  ${'matchup'.padEnd(26)} ${'wins'.padEnd(8)} ${'losses'.padEnd(8)} draws`);
console.log(`  ${'-'.repeat(26)} ${'-'.repeat(8)} ${'-'.repeat(8)} -----`);
for (let i = 0; i < LEVELS.length; i++) {
  for (let j = i + 1; j < LEVELS.length; j++) {
    const a = LEVELS[i], b = LEVELS[j];
    const { aWins, bWins, draws } = match(a, b, GAMES);
    console.log(`  ${`${a} vs ${b}`.padEnd(26)} ${pct(aWins, GAMES).padEnd(8)} ${pct(bWins, GAMES).padEnd(8)} ${pct(draws, GAMES)}`);
  }
}

/**
 * The number the card economy actually turns on.
 *
 * The bot always JOINS, so it is always player 2 — the weaker seat. Card
 * transfer is zero-sum (winner +1, loser -1), so its collection grows or
 * shrinks with its win rate in that seat. This sweeps the skill dial against a
 * fixed opponent strength to find where it breaks even.
 */
function asPlayer2(skill: number, opponent: BotDifficulty, games: number) {
  let botWins = 0, botLosses = 0, draws = 0;
  for (let i = 0; i < games; i++) {
    let state: GameState = createGame(randomHand(Math.random), randomHand(Math.random));
    while (!isGameOver(state)) {
      const who = state.currentTurn;
      const move = who === 'player2'
        ? chooseBotMove(state, { difficulty: 'lookahead', skill })
        : chooseBotMove(state, { difficulty: opponent });
      state = placeCard(state, who, move.handIndex, move.row, move.col).newState;
    }
    const { player1, player2 } = calculateScores(state);
    if (player1 === player2) draws++;
    else if (player2 > player1) botWins++;
    else botLosses++;
  }
  return { botWins, botLosses, draws, drift: (botWins - botLosses) / games };
}

console.log(`\n  Bot as player 2 (its only seat) vs a GREEDY opponent — card drift per game\n`);
console.log(`  ${'skill'.padEnd(8)} ${'bot wins'.padEnd(10)} ${'bot loses'.padEnd(10)} ${'draws'.padEnd(8)} drift/game`);
console.log(`  ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(8)} ----------`);
for (const skill of [0, 0.25, 0.5, 0.75, 1]) {
  const r = asPlayer2(skill, 'greedy', GAMES);
  const d = r.drift >= 0 ? `+${r.drift.toFixed(2)}` : r.drift.toFixed(2);
  console.log(`  ${String(skill).padEnd(8)} ${pct(r.botWins, GAMES).padEnd(10)} ${pct(r.botLosses, GAMES).padEnd(10)} ${pct(r.draws, GAMES).padEnd(8)} ${d}`);
}

console.log(`\n  Seat bias (level against itself — player 1 places 5 cards, player 2 places 4)\n`);
for (const level of LEVELS) {
  const { p1, p2, draws } = seatBias(level, GAMES);
  console.log(`  ${level.padEnd(12)} p1 ${pct(p1, GAMES).padEnd(8)} p2 ${pct(p2, GAMES).padEnd(8)} draw ${pct(draws, GAMES)}`);
}
console.log();
