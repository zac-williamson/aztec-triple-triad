import type { Card } from '../types';
import { CARD_DATABASE } from '../cards';
// Tutorial card IDs are 101–110 — outside the normal 1–50 range so they
// are never added to the player's collection.

export const PLAYER_TUTORIAL_HAND: Card[] = [
 CARD_DATABASE[1],
 CARD_DATABASE[9],
 CARD_DATABASE[2],
 CARD_DATABASE[3],
 CARD_DATABASE[0], 
];

// ── Phase 2: Timmy's hand (IDs 201–205) ─────────────────────────────────
// Intentionally terrible cards — the gag is Timmy brags about his "legendary"
// hidden cards which turn out to be an old boot and a lost cat.

export const TIMMY_TUTORIAL_HAND: Card[] = [
  {
    id: 201,
    name: "Timmy's Friend",
    ranks: { top: 1, right: 2, bottom: 1, left: 1 },
    imageUrl: '/cards/final/card-201.png',
  },
  {
    id: 202,
    name: "Timmy's Other Friend",
    ranks: { top: 2, right: 1, bottom: 1, left: 1 },
    imageUrl: '/cards/final/card-202.png',
  },
  {
    id: 203,
    name: 'Timmy',
    ranks: { top: 2, right: 2, bottom: 2, left: 2 },
    imageUrl: '/cards/final/card-203.png',
  },
  {
    id: 204,
    name: 'Old Boot',
    ranks: { top: 1, right: 1, bottom: 1, left: 1 },
    imageUrl: '/cards/final/card-204.png',
  },
  {
    id: 205,
    name: 'Lost Cat',
    ranks: { top: 1, right: 1, bottom: 1, left: 1 },
    imageUrl: '/cards/final/card-205.png',
  },
];

export const XOCHITL_TUTORIAL_HAND: Card[] = [
 CARD_DATABASE[0],
 CARD_DATABASE[1],
 CARD_DATABASE[2],
 CARD_DATABASE[3],
 CARD_DATABASE[10],
];
