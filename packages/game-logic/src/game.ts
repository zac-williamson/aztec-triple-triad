import type { Card, Board, BoardCell, GameState, Player, PlaceCardResult } from './types.js';

function createEmptyBoard(): Board {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 3 }, (): BoardCell => ({ card: null, owner: null }))
  );
}

function cloneBoard(board: Board): Board {
  return board.map(row =>
    row.map(cell => ({ card: cell.card ? { ...cell.card, ranks: { ...cell.card.ranks } } : null, owner: cell.owner }))
  );
}

export function createGame(player1Hand: Card[], player2Hand: Card[]): GameState {
  if (player1Hand.length !== 5 || player2Hand.length !== 5) {
    throw new Error('Each player must have exactly 5 cards');
  }

  return {
    board: createEmptyBoard(),
    player1Hand: player1Hand.map(c => ({ ...c, ranks: { ...c.ranks } })),
    player2Hand: player2Hand.map(c => ({ ...c, ranks: { ...c.ranks } })),
    currentTurn: 'player1',
    player1Score: 5,
    player2Score: 5,
    status: 'playing',
    winner: null,
  };
}

const DIRECTIONS: { dr: number; dc: number; attackerRank: keyof Card['ranks']; defenderRank: keyof Card['ranks'] }[] = [
  { dr: -1, dc: 0, attackerRank: 'top', defenderRank: 'bottom' },
  { dr: 1, dc: 0, attackerRank: 'bottom', defenderRank: 'top' },
  { dr: 0, dc: -1, attackerRank: 'left', defenderRank: 'right' },
  { dr: 0, dc: 1, attackerRank: 'right', defenderRank: 'left' },
];

function resolveCaptures(board: Board, row: number, col: number, player: Player): { row: number; col: number }[] {
  const placedCard = board[row][col].card!;
  const captures: { row: number; col: number }[] = [];

  for (const dir of DIRECTIONS) {
    const nr = row + dir.dr;
    const nc = col + dir.dc;

    if (nr < 0 || nr > 2 || nc < 0 || nc > 2) continue;

    const neighbor = board[nr][nc];
    if (!neighbor.card || neighbor.owner === player) continue;

    const attackValue = placedCard.ranks[dir.attackerRank];
    const defendValue = neighbor.card.ranks[dir.defenderRank];

    if (attackValue > defendValue) {
      captures.push({ row: nr, col: nc });
    }
  }

  return captures;
}

export function calculateScores(state: GameState): { player1: number; player2: number } {
  let p1 = state.player1Hand.length;
  let p2 = state.player2Hand.length;

  for (const row of state.board) {
    for (const cell of row) {
      if (cell.owner === 'player1') p1++;
      else if (cell.owner === 'player2') p2++;
    }
  }

  return { player1: p1, player2: p2 };
}

export function isGameOver(state: GameState): boolean {
  for (const row of state.board) {
    for (const cell of row) {
      if (cell.card === null) return false;
    }
  }
  return true;
}

export function getValidPlacements(state: GameState): { row: number; col: number }[] {
  const placements: { row: number; col: number }[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (state.board[r][c].card === null) {
        placements.push({ row: r, col: c });
      }
    }
  }
  return placements;
}

export function placeCard(
  state: GameState,
  player: Player,
  handIndex: number,
  row: number,
  col: number,
): PlaceCardResult {
  if (state.status === 'finished') {
    throw new Error('Game is already finished');
  }

  if (state.currentTurn !== player) {
    throw new Error(`It is not ${player}'s turn`);
  }

  if (row < 0 || row > 2 || col < 0 || col > 2) {
    throw new Error(`Invalid position: (${row}, ${col})`);
  }

  const hand = player === 'player1' ? state.player1Hand : state.player2Hand;

  if (handIndex < 0 || handIndex >= hand.length) {
    throw new Error(`Invalid hand index: ${handIndex}`);
  }

  if (state.board[row][col].card !== null) {
    throw new Error(`Cell (${row}, ${col}) is already occupied`);
  }

  // Clone state
  const newBoard = cloneBoard(state.board);
  const newP1Hand = state.player1Hand.map(c => ({ ...c, ranks: { ...c.ranks } }));
  const newP2Hand = state.player2Hand.map(c => ({ ...c, ranks: { ...c.ranks } }));

  const newHand = player === 'player1' ? newP1Hand : newP2Hand;
  const card = newHand.splice(handIndex, 1)[0];

  // Place the card
  newBoard[row][col] = { card, owner: player };

  // Resolve captures
  const captures = resolveCaptures(newBoard, row, col, player);
  for (const cap of captures) {
    newBoard[cap.row][cap.col].owner = player;
  }

  // Build new state
  const nextTurn: Player = player === 'player1' ? 'player2' : 'player1';

  let newState: GameState = {
    board: newBoard,
    player1Hand: newP1Hand,
    player2Hand: newP2Hand,
    currentTurn: nextTurn,
    player1Score: 0,
    player2Score: 0,
    status: 'playing',
    winner: null,
  };

  // Calculate scores
  const scores = calculateScores(newState);
  newState.player1Score = scores.player1;
  newState.player2Score = scores.player2;

  // Check game end
  if (isGameOver(newState)) {
    newState.status = 'finished';
    if (scores.player1 > scores.player2) {
      newState.winner = 'player1';
    } else if (scores.player2 > scores.player1) {
      newState.winner = 'player2';
    } else {
      newState.winner = 'draw';
    }
  }

  return { newState, captures };
}
