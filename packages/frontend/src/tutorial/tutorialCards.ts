import type { Card } from '../types';

// Tutorial card IDs are 101–110 — outside the normal 1–50 range so they
// are never added to the player's collection.

export const PLAYER_TUTORIAL_HAND: Card[] = [
  {
    id: 101,
    name: 'Stone Lizard',
    ranks: { top: 2, right: 5, bottom: 2, left: 3 },
    imageUrl: '/cards/final/card-1.png',
  },
  {
    id: 102,
    name: 'Vine Creeper',
    ranks: { top: 4, right: 4, bottom: 6, left: 1 },
    imageUrl: '/cards/final/card-2.png',
  },
  {
    id: 103,
    name: 'River Drake',
    ranks: { top: 7, right: 3, bottom: 5, left: 7 },
    imageUrl: '/cards/final/card-3.png',
  },
  {
    id: 104,
    name: 'Marsh Hawk',
    ranks: { top: 5, right: 6, bottom: 4, left: 6 },
    imageUrl: '/cards/final/card-4.png',
  },
  {
    id: 105,
    name: 'Storm Elder',
    ranks: { top: 8, right: 8, bottom: 6, left: 7 },
    imageUrl: '/cards/final/card-5.png',
  },
];

export const XOCHITL_TUTORIAL_HAND: Card[] = [
  {
    id: 106,
    name: 'Swamp Sprite',
    ranks: { top: 3, right: 2, bottom: 4, left: 2 },
    imageUrl: '/cards/final/card-6.png',
  },
  {
    id: 107,
    name: 'Reed Dancer',
    ranks: { top: 5, right: 1, bottom: 3, left: 5 },
    imageUrl: '/cards/final/card-7.png',
  },
  {
    id: 108,
    name: 'Mud Golem',
    ranks: { top: 6, right: 6, bottom: 2, left: 4 },
    imageUrl: '/cards/final/card-8.png',
  },
  {
    id: 109,
    name: 'Bog Witch',
    ranks: { top: 7, right: 3, bottom: 7, left: 5 },
    imageUrl: '/cards/final/card-9.png',
  },
  {
    id: 110,
    name: 'Swamp King',
    ranks: { top: 8, right: 7, bottom: 8, left: 6 },
    imageUrl: '/cards/final/card-10.png',
  },
];
