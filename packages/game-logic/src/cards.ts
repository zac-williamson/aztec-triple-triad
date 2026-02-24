import { Card } from './types.js';

/**
 * Card database for Triple Triad.
 * Each card has ranks 1-10 (A=10) for top, right, bottom, left.
 * Cards are inspired by Final Fantasy creatures with balanced rank distributions.
 */
export const CARD_DATABASE: Card[] = [
  // Level 1 cards (low ranks, total ~8-12)
  { id: 1, name: 'Geezard', ranks: { top: 1, right: 4, bottom: 1, left: 5 } },
  { id: 2, name: 'Funguar', ranks: { top: 5, right: 1, bottom: 1, left: 3 } },
  { id: 3, name: 'Bite Bug', ranks: { top: 1, right: 3, bottom: 3, left: 5 } },
  { id: 4, name: 'Red Bat', ranks: { top: 6, right: 1, bottom: 1, left: 2 } },
  { id: 5, name: 'Blobra', ranks: { top: 2, right: 3, bottom: 1, left: 5 } },
  { id: 6, name: 'Gayla', ranks: { top: 2, right: 1, bottom: 4, left: 4 } },
  { id: 7, name: 'Gesper', ranks: { top: 1, right: 5, bottom: 4, left: 1 } },
  { id: 8, name: 'Fastitocalon-F', ranks: { top: 3, right: 1, bottom: 5, left: 2 } },
  { id: 9, name: 'Blood Soul', ranks: { top: 2, right: 1, bottom: 6, left: 1 } },
  { id: 10, name: 'Caterchipillar', ranks: { top: 4, right: 3, bottom: 2, left: 4 } },

  // Level 2 cards (moderate ranks, total ~13-16)
  { id: 11, name: 'Cockatrice', ranks: { top: 2, right: 6, bottom: 1, left: 6 } },
  { id: 12, name: 'Grat', ranks: { top: 7, right: 1, bottom: 3, left: 1 } },
  { id: 13, name: 'Buel', ranks: { top: 6, right: 2, bottom: 2, left: 3 } },
  { id: 14, name: 'Mesmerize', ranks: { top: 5, right: 3, bottom: 3, left: 4 } },
  { id: 15, name: 'Glacial Eye', ranks: { top: 6, right: 1, bottom: 4, left: 3 } },
  { id: 16, name: 'Belhelmel', ranks: { top: 3, right: 4, bottom: 5, left: 3 } },
  { id: 17, name: 'Thrustaevis', ranks: { top: 5, right: 3, bottom: 2, left: 5 } },
  { id: 18, name: 'Anacondaur', ranks: { top: 5, right: 1, bottom: 3, left: 5 } },
  { id: 19, name: 'Creeps', ranks: { top: 5, right: 2, bottom: 5, left: 2 } },
  { id: 20, name: 'Grendel', ranks: { top: 4, right: 2, bottom: 4, left: 5 } },

  // Level 3 cards (good ranks, total ~17-20)
  { id: 21, name: 'Jelleye', ranks: { top: 3, right: 7, bottom: 2, left: 5 } },
  { id: 22, name: 'Grand Mantis', ranks: { top: 5, right: 2, bottom: 5, left: 5 } },
  { id: 23, name: 'Forbidden', ranks: { top: 6, right: 6, bottom: 3, left: 3 } },
  { id: 24, name: 'Armadodo', ranks: { top: 6, right: 3, bottom: 6, left: 3 } },
  { id: 25, name: 'Tri-Face', ranks: { top: 3, right: 5, bottom: 5, left: 5 } },
  { id: 26, name: 'Fastitocalon', ranks: { top: 7, right: 5, bottom: 1, left: 3 } },
  { id: 27, name: 'Snow Lion', ranks: { top: 7, right: 1, bottom: 5, left: 3 } },
  { id: 28, name: 'Ochu', ranks: { top: 5, right: 3, bottom: 6, left: 3 } },
  { id: 29, name: 'SAM08G', ranks: { top: 5, right: 6, bottom: 2, left: 4 } },
  { id: 30, name: 'Death Claw', ranks: { top: 4, right: 4, bottom: 7, left: 2 } },

  // Level 4 cards (strong ranks, total ~21-24)
  { id: 31, name: 'Tonberry', ranks: { top: 3, right: 6, bottom: 4, left: 7 } },
  { id: 32, name: 'Abyss Worm', ranks: { top: 7, right: 2, bottom: 3, left: 7 } },
  { id: 33, name: 'Turtapod', ranks: { top: 2, right: 3, bottom: 7, left: 7 } },
  { id: 34, name: 'Vysage', ranks: { top: 6, right: 5, bottom: 5, left: 5 } },
  { id: 35, name: 'T-Rexaur', ranks: { top: 4, right: 7, bottom: 6, left: 2 } },
  { id: 36, name: 'Bomb', ranks: { top: 2, right: 3, bottom: 7, left: 8 } },
  { id: 37, name: 'Blitz', ranks: { top: 1, right: 7, bottom: 6, left: 4 } },
  { id: 38, name: 'Wendigo', ranks: { top: 7, right: 3, bottom: 1, left: 6 } },
  { id: 39, name: 'Torama', ranks: { top: 7, right: 4, bottom: 4, left: 4 } },
  { id: 40, name: 'Imp', ranks: { top: 3, right: 7, bottom: 3, left: 6 } },

  // Level 5 cards (elite ranks, total ~25-28)
  { id: 41, name: 'Blue Dragon', ranks: { top: 6, right: 7, bottom: 3, left: 7 } },
  { id: 42, name: 'Abadon', ranks: { top: 6, right: 5, bottom: 8, left: 4 } },
  { id: 43, name: 'Iron Giant', ranks: { top: 6, right: 5, bottom: 6, left: 6 } },
  { id: 44, name: 'Behemoth', ranks: { top: 3, right: 6, bottom: 7, left: 8 } },
  { id: 45, name: 'Chimera', ranks: { top: 7, right: 6, bottom: 5, left: 6 } },
  { id: 46, name: 'PuPu', ranks: { top: 3, right: 10, bottom: 2, left: 1 } },
  { id: 47, name: 'Elastoid', ranks: { top: 6, right: 2, bottom: 6, left: 7 } },
  { id: 48, name: 'GIM47N', ranks: { top: 5, right: 5, bottom: 7, left: 6 } },
  { id: 49, name: 'Malboro', ranks: { top: 7, right: 7, bottom: 4, left: 2 } },
  { id: 50, name: 'Ruby Dragon', ranks: { top: 7, right: 2, bottom: 7, left: 4 } },
];

export function getCardById(id: number): Card | undefined {
  return CARD_DATABASE.find((c) => c.id === id);
}

export function getCardsByIds(ids: number[]): Card[] {
  return ids.map((id) => {
    const card = getCardById(id);
    if (!card) throw new Error(`Card with id ${id} not found`);
    return { ...card };
  });
}
