import type { Card } from './types';

export const CARD_DATABASE: Card[] = [
  // Level 1 — Common (IDs 1-10)
  { id: 1, name: 'Mudwalker', ranks: { top: 1, right: 4, bottom: 1, left: 5 } },
  { id: 2, name: 'Blushy', ranks: { top: 5, right: 1, bottom: 1, left: 3 } },
  { id: 3, name: 'Snowdrop', ranks: { top: 1, right: 3, bottom: 3, left: 5 } },
  { id: 4, name: 'Sunny', ranks: { top: 6, right: 1, bottom: 1, left: 2 } },
  { id: 5, name: 'Inkwell', ranks: { top: 2, right: 3, bottom: 1, left: 5 } },
  { id: 6, name: 'Stripes', ranks: { top: 2, right: 1, bottom: 4, left: 4 } },
  { id: 7, name: 'Barkeeper', ranks: { top: 1, right: 5, bottom: 4, left: 1 } },
  { id: 8, name: 'Dotty', ranks: { top: 3, right: 1, bottom: 5, left: 2 } },
  { id: 9, name: 'Penny', ranks: { top: 2, right: 1, bottom: 6, left: 1 } },
  { id: 10, name: 'Peaches', ranks: { top: 4, right: 3, bottom: 2, left: 4 } },
  // Level 2 — Uncommon (IDs 11-20)
  { id: 11, name: 'Freckles', ranks: { top: 2, right: 6, bottom: 1, left: 6 } },
  { id: 12, name: 'Camo', ranks: { top: 7, right: 1, bottom: 3, left: 1 } },
  { id: 13, name: 'Neon', ranks: { top: 6, right: 2, bottom: 2, left: 3 } },
  { id: 14, name: 'Glow Bug', ranks: { top: 5, right: 3, bottom: 3, left: 4 } },
  { id: 15, name: 'Limelight', ranks: { top: 6, right: 1, bottom: 4, left: 3 } },
  { id: 16, name: 'Marble', ranks: { top: 3, right: 4, bottom: 5, left: 3 } },
  { id: 17, name: 'Sapphire', ranks: { top: 5, right: 3, bottom: 2, left: 5 } },
  { id: 18, name: 'Jefferson', ranks: { top: 5, right: 1, bottom: 3, left: 5 } },
  { id: 19, name: 'Longfoot', ranks: { top: 5, right: 2, bottom: 5, left: 2 } },
  { id: 20, name: 'Featherfin', ranks: { top: 4, right: 2, bottom: 4, left: 5 } },
  // Level 3 — Rare (IDs 21-30)
  { id: 21, name: 'Lilac', ranks: { top: 3, right: 7, bottom: 2, left: 5 } },
  { id: 22, name: 'Patches', ranks: { top: 5, right: 2, bottom: 5, left: 5 } },
  { id: 23, name: 'Faded', ranks: { top: 6, right: 6, bottom: 3, left: 3 } },
  { id: 24, name: 'Gold Dust', ranks: { top: 6, right: 3, bottom: 6, left: 3 } },
  { id: 25, name: 'Phantom', ranks: { top: 3, right: 5, bottom: 5, left: 5 } },
  { id: 26, name: 'Ash', ranks: { top: 7, right: 5, bottom: 1, left: 3 } },
  { id: 27, name: 'Cocoa', ranks: { top: 7, right: 1, bottom: 5, left: 3 } },
  { id: 28, name: 'Ringmaster', ranks: { top: 5, right: 3, bottom: 6, left: 3 } },
  { id: 29, name: 'Goldrush', ranks: { top: 5, right: 6, bottom: 2, left: 4 } },
  { id: 30, name: 'Swampling', ranks: { top: 4, right: 4, bottom: 7, left: 2 } },
  // Level 4 — Epic (IDs 31-40)
  { id: 31, name: 'Glitter', ranks: { top: 3, right: 6, bottom: 4, left: 7 } },
  { id: 32, name: 'Starfield', ranks: { top: 7, right: 2, bottom: 3, left: 7 } },
  { id: 33, name: 'Specter', ranks: { top: 2, right: 3, bottom: 7, left: 7 } },
  { id: 34, name: 'Saffron', ranks: { top: 6, right: 5, bottom: 5, left: 5 } },
  { id: 35, name: 'Stardust', ranks: { top: 4, right: 7, bottom: 6, left: 2 } },
  { id: 36, name: 'Achoque', ranks: { top: 2, right: 3, bottom: 7, left: 8 } },
  { id: 37, name: 'Zacapu', ranks: { top: 1, right: 7, bottom: 6, left: 4 } },
  { id: 38, name: 'Laguna', ranks: { top: 7, right: 3, bottom: 1, left: 6 } },
  { id: 39, name: 'Streamwalker', ranks: { top: 7, right: 4, bottom: 4, left: 4 } },
  { id: 40, name: 'Digger', ranks: { top: 3, right: 7, bottom: 3, left: 6 } },
  // Level 5 — Legendary (IDs 41-50)
  { id: 41, name: 'Eclipse', ranks: { top: 6, right: 7, bottom: 3, left: 7 } },
  { id: 42, name: 'Kaleidoscope', ranks: { top: 6, right: 5, bottom: 8, left: 4 } },
  { id: 43, name: 'Twinned', ranks: { top: 6, right: 5, bottom: 6, left: 6 } },
  { id: 44, name: 'Sparkletail', ranks: { top: 3, right: 6, bottom: 7, left: 8 } },
  { id: 45, name: 'Riddler', ranks: { top: 7, right: 6, bottom: 5, left: 6 } },
  { id: 46, name: 'Rosita', ranks: { top: 3, right: 10, bottom: 2, left: 1 } },
  { id: 47, name: 'Brooklet', ranks: { top: 6, right: 2, bottom: 6, left: 7 } },
  { id: 48, name: 'Whisper', ranks: { top: 5, right: 5, bottom: 7, left: 6 } },
  { id: 49, name: 'Misty', ranks: { top: 7, right: 7, bottom: 4, left: 2 } },
  { id: 50, name: 'Lerma', ranks: { top: 7, right: 2, bottom: 7, left: 4 } },
];

export function getCardById(id: number): Card | undefined {
  return CARD_DATABASE.find((c) => c.id === id);
}

export function getRandomHand(count = 5): Card[] {
  const shuffled = [...CARD_DATABASE].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(c => ({ ...c }));
}

export function getRandomHandIds(count = 5): number[] {
  const shuffled = [...CARD_DATABASE].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(c => c.id);
}

export function formatRank(rank: number): string {
  return rank === 10 ? 'A' : String(rank);
}
