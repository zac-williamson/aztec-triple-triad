import { Card } from './types.js';

/**
 * Card database for Axolotl Arena — GENERATED FILE, DO NOT HAND-EDIT.
 *
 * Source of truth: scripts/card-database-256.json (repo root), which also
 * generates circuits/card_data/src/lib.nr (what proofs enforce) and
 * packages/frontend/src/cards.ts (what players see). Regenerate with
 * `npm run generate:cards` in packages/game-logic; tests/cards.test.ts
 * pins this file against the JSON.
 *
 * Each card has ranks 1-10 (A=10) for top, right, bottom, left. Rarity bands
 * are positional by id, mirroring CARDS_PER_POOL in triple_triad_nft.
 */
export const CARD_DATABASE: Card[] = [
  // Common (ids 1-10)
  { id: 1, name: 'Mudwalker', ranks: { top: 1, right: 4, bottom: 1, left: 5 }, rarity: 'common' },
  { id: 2, name: 'Blushy', ranks: { top: 5, right: 1, bottom: 1, left: 3 }, rarity: 'common' },
  { id: 3, name: 'Snowdrop', ranks: { top: 1, right: 3, bottom: 3, left: 5 }, rarity: 'common' },
  { id: 4, name: 'Sunny', ranks: { top: 6, right: 1, bottom: 1, left: 2 }, rarity: 'common' },
  { id: 5, name: 'Inkwell', ranks: { top: 2, right: 3, bottom: 1, left: 5 }, rarity: 'common' },
  { id: 6, name: 'Stripes', ranks: { top: 2, right: 1, bottom: 4, left: 4 }, rarity: 'common' },
  { id: 7, name: 'Barkeeper', ranks: { top: 1, right: 5, bottom: 4, left: 1 }, rarity: 'common' },
  { id: 8, name: 'Dotty', ranks: { top: 3, right: 1, bottom: 5, left: 2 }, rarity: 'common' },
  { id: 9, name: 'Penny', ranks: { top: 2, right: 1, bottom: 6, left: 1 }, rarity: 'common' },
  { id: 10, name: 'Peaches', ranks: { top: 4, right: 3, bottom: 2, left: 4 }, rarity: 'common' },

  // Uncommon (ids 11-176)
  { id: 11, name: 'Freckles', ranks: { top: 2, right: 6, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 12, name: 'Camo', ranks: { top: 7, right: 1, bottom: 3, left: 1 }, rarity: 'uncommon' },
  { id: 13, name: 'Neon', ranks: { top: 6, right: 2, bottom: 2, left: 3 }, rarity: 'uncommon' },
  { id: 14, name: 'Glow Bug', ranks: { top: 5, right: 3, bottom: 3, left: 4 }, rarity: 'uncommon' },
  { id: 15, name: 'Limelight', ranks: { top: 6, right: 1, bottom: 4, left: 3 }, rarity: 'uncommon' },
  { id: 16, name: 'Marble', ranks: { top: 3, right: 4, bottom: 5, left: 3 }, rarity: 'uncommon' },
  { id: 17, name: 'Sapphire', ranks: { top: 5, right: 3, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 18, name: 'Jefferson', ranks: { top: 5, right: 1, bottom: 3, left: 5 }, rarity: 'uncommon' },
  { id: 19, name: 'Longfoot', ranks: { top: 5, right: 2, bottom: 5, left: 2 }, rarity: 'uncommon' },
  { id: 20, name: 'Featherfin', ranks: { top: 4, right: 2, bottom: 4, left: 5 }, rarity: 'uncommon' },
  { id: 21, name: 'Lilac', ranks: { top: 3, right: 7, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 22, name: 'Patches', ranks: { top: 5, right: 2, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 23, name: 'Faded', ranks: { top: 6, right: 6, bottom: 3, left: 3 }, rarity: 'uncommon' },
  { id: 24, name: 'Gold Dust', ranks: { top: 6, right: 3, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 25, name: 'Phantom', ranks: { top: 3, right: 5, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 26, name: 'Ash', ranks: { top: 7, right: 5, bottom: 1, left: 3 }, rarity: 'uncommon' },
  { id: 27, name: 'Cocoa', ranks: { top: 7, right: 1, bottom: 5, left: 3 }, rarity: 'uncommon' },
  { id: 28, name: 'Ringmaster', ranks: { top: 5, right: 3, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 29, name: 'Goldrush', ranks: { top: 5, right: 6, bottom: 2, left: 4 }, rarity: 'uncommon' },
  { id: 30, name: 'Swampling', ranks: { top: 4, right: 4, bottom: 7, left: 2 }, rarity: 'uncommon' },
  { id: 31, name: 'Glitter', ranks: { top: 3, right: 6, bottom: 4, left: 7 }, rarity: 'uncommon' },
  { id: 32, name: 'Starfield', ranks: { top: 7, right: 2, bottom: 3, left: 7 }, rarity: 'uncommon' },
  { id: 33, name: 'Specter', ranks: { top: 2, right: 3, bottom: 7, left: 7 }, rarity: 'uncommon' },
  { id: 34, name: 'Saffron', ranks: { top: 6, right: 5, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 35, name: 'Stardust', ranks: { top: 4, right: 7, bottom: 6, left: 2 }, rarity: 'uncommon' },
  { id: 36, name: 'Achoque', ranks: { top: 2, right: 3, bottom: 7, left: 8 }, rarity: 'uncommon' },
  { id: 37, name: 'Zacapu', ranks: { top: 1, right: 7, bottom: 6, left: 4 }, rarity: 'uncommon' },
  { id: 38, name: 'Laguna', ranks: { top: 7, right: 3, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 39, name: 'Streamwalker', ranks: { top: 7, right: 4, bottom: 4, left: 4 }, rarity: 'uncommon' },
  { id: 40, name: 'Digger', ranks: { top: 3, right: 7, bottom: 3, left: 6 }, rarity: 'uncommon' },
  { id: 41, name: 'Eclipse', ranks: { top: 6, right: 7, bottom: 3, left: 7 }, rarity: 'uncommon' },
  { id: 42, name: 'Kaleidoscope', ranks: { top: 6, right: 5, bottom: 8, left: 4 }, rarity: 'uncommon' },
  { id: 43, name: 'Twinned', ranks: { top: 6, right: 5, bottom: 6, left: 6 }, rarity: 'uncommon' },
  { id: 44, name: 'Sparkletail', ranks: { top: 3, right: 6, bottom: 7, left: 8 }, rarity: 'uncommon' },
  { id: 45, name: 'Riddler', ranks: { top: 7, right: 6, bottom: 5, left: 6 }, rarity: 'uncommon' },
  { id: 46, name: 'Rosita', ranks: { top: 3, right: 10, bottom: 2, left: 1 }, rarity: 'uncommon' },
  { id: 47, name: 'Brooklet', ranks: { top: 6, right: 2, bottom: 6, left: 7 }, rarity: 'uncommon' },
  { id: 48, name: 'Whisper', ranks: { top: 5, right: 5, bottom: 7, left: 6 }, rarity: 'uncommon' },
  { id: 49, name: 'Misty', ranks: { top: 7, right: 7, bottom: 4, left: 2 }, rarity: 'uncommon' },
  { id: 50, name: 'Lerma', ranks: { top: 7, right: 2, bottom: 7, left: 4 }, rarity: 'uncommon' },
  { id: 51, name: 'Puddle', ranks: { top: 4, right: 2, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 52, name: 'Trickle', ranks: { top: 2, right: 5, bottom: 3, left: 6 }, rarity: 'uncommon' },
  { id: 53, name: 'Dewdrop', ranks: { top: 5, right: 1, bottom: 4, left: 5 }, rarity: 'uncommon' },
  { id: 54, name: 'Sprout', ranks: { top: 2, right: 4, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 55, name: 'Nibbles', ranks: { top: 3, right: 2, bottom: 4, left: 5 }, rarity: 'uncommon' },
  { id: 56, name: 'Pebble', ranks: { top: 4, right: 2, bottom: 5, left: 2 }, rarity: 'uncommon' },
  { id: 57, name: 'Clover', ranks: { top: 2, right: 1, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 58, name: 'Dapple', ranks: { top: 6, right: 1, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 59, name: 'Flicker', ranks: { top: 5, right: 1, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 60, name: 'Rustle', ranks: { top: 1, right: 5, bottom: 2, left: 6 }, rarity: 'uncommon' },
  { id: 61, name: 'Wisp', ranks: { top: 4, right: 5, bottom: 2, left: 2 }, rarity: 'uncommon' },
  { id: 62, name: 'Bramble', ranks: { top: 4, right: 3, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 63, name: 'Thistle', ranks: { top: 4, right: 1, bottom: 6, left: 4 }, rarity: 'uncommon' },
  { id: 64, name: 'Burrow', ranks: { top: 4, right: 4, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 65, name: 'Cricket', ranks: { top: 5, right: 2, bottom: 6, left: 2 }, rarity: 'uncommon' },
  { id: 66, name: 'Minnow', ranks: { top: 2, right: 4, bottom: 5, left: 1 }, rarity: 'uncommon' },
  { id: 67, name: 'Pinecone', ranks: { top: 2, right: 4, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 68, name: 'Acorn', ranks: { top: 3, right: 3, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 69, name: 'Mushroom', ranks: { top: 3, right: 5, bottom: 2, left: 3 }, rarity: 'uncommon' },
  { id: 70, name: 'Fiddlehead', ranks: { top: 4, right: 3, bottom: 3, left: 4 }, rarity: 'uncommon' },
  { id: 71, name: 'Tadpole', ranks: { top: 5, right: 6, bottom: 2, left: 2 }, rarity: 'uncommon' },
  { id: 72, name: 'Drizzle', ranks: { top: 2, right: 3, bottom: 5, left: 4 }, rarity: 'uncommon' },
  { id: 73, name: 'Duskweed', ranks: { top: 2, right: 6, bottom: 3, left: 1 }, rarity: 'uncommon' },
  { id: 74, name: 'Cattail', ranks: { top: 2, right: 6, bottom: 3, left: 5 }, rarity: 'uncommon' },
  { id: 75, name: 'Bulrush', ranks: { top: 1, right: 2, bottom: 6, left: 6 }, rarity: 'uncommon' },
  { id: 76, name: 'Lichen', ranks: { top: 1, right: 4, bottom: 6, left: 5 }, rarity: 'uncommon' },
  { id: 77, name: 'Toadskin', ranks: { top: 2, right: 3, bottom: 4, left: 6 }, rarity: 'uncommon' },
  { id: 78, name: 'Barnacle', ranks: { top: 4, right: 1, bottom: 5, left: 2 }, rarity: 'uncommon' },
  { id: 79, name: 'Kelp', ranks: { top: 2, right: 3, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 80, name: 'Driftwood', ranks: { top: 3, right: 5, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 81, name: 'Ripple', ranks: { top: 6, right: 2, bottom: 2, left: 4 }, rarity: 'uncommon' },
  { id: 82, name: 'Current', ranks: { top: 1, right: 6, bottom: 5, left: 3 }, rarity: 'uncommon' },
  { id: 83, name: 'Eddy', ranks: { top: 6, right: 3, bottom: 1, left: 4 }, rarity: 'uncommon' },
  { id: 84, name: 'Brook', ranks: { top: 1, right: 6, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 85, name: 'Mossheart', ranks: { top: 5, right: 1, bottom: 6, left: 2 }, rarity: 'uncommon' },
  { id: 86, name: 'Reedling', ranks: { top: 3, right: 4, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 87, name: 'Fernback', ranks: { top: 6, right: 5, bottom: 1, left: 1 }, rarity: 'uncommon' },
  { id: 88, name: 'Cobble', ranks: { top: 5, right: 3, bottom: 2, left: 4 }, rarity: 'uncommon' },
  { id: 89, name: 'Shingle', ranks: { top: 6, right: 1, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 90, name: 'Dampfoot', ranks: { top: 6, right: 4, bottom: 1, left: 2 }, rarity: 'uncommon' },
  { id: 91, name: 'Mudskipper', ranks: { top: 3, right: 6, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 92, name: 'Puddlejump', ranks: { top: 2, right: 5, bottom: 3, left: 5 }, rarity: 'uncommon' },
  { id: 93, name: 'Bogbean', ranks: { top: 4, right: 1, bottom: 3, left: 6 }, rarity: 'uncommon' },
  { id: 94, name: 'Waterlily', ranks: { top: 1, right: 4, bottom: 6, left: 4 }, rarity: 'uncommon' },
  { id: 95, name: 'Pondweed', ranks: { top: 6, right: 5, bottom: 4, left: 1 }, rarity: 'uncommon' },
  { id: 96, name: 'Duckweed', ranks: { top: 1, right: 2, bottom: 6, left: 6 }, rarity: 'uncommon' },
  { id: 97, name: 'Silverfin', ranks: { top: 3, right: 2, bottom: 3, left: 5 }, rarity: 'uncommon' },
  { id: 98, name: 'Quicksand', ranks: { top: 2, right: 6, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 99, name: 'Rainfall', ranks: { top: 4, right: 6, bottom: 4, left: 2 }, rarity: 'uncommon' },
  { id: 100, name: 'Foghorn', ranks: { top: 3, right: 5, bottom: 3, left: 2 }, rarity: 'uncommon' },
  { id: 101, name: 'Mistletoe', ranks: { top: 6, right: 3, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 102, name: 'Juniper', ranks: { top: 5, right: 5, bottom: 2, left: 1 }, rarity: 'uncommon' },
  { id: 103, name: 'Hazelnut', ranks: { top: 1, right: 4, bottom: 5, left: 6 }, rarity: 'uncommon' },
  { id: 104, name: 'Walnut', ranks: { top: 1, right: 5, bottom: 5, left: 2 }, rarity: 'uncommon' },
  { id: 105, name: 'Chestnut', ranks: { top: 6, right: 5, bottom: 1, left: 2 }, rarity: 'uncommon' },
  { id: 106, name: 'Birchbark', ranks: { top: 2, right: 3, bottom: 5, left: 4 }, rarity: 'uncommon' },
  { id: 107, name: 'Pinewood', ranks: { top: 2, right: 2, bottom: 4, left: 5 }, rarity: 'uncommon' },
  { id: 108, name: 'Willowbend', ranks: { top: 6, right: 3, bottom: 3, left: 4 }, rarity: 'uncommon' },
  { id: 109, name: 'Elmshade', ranks: { top: 2, right: 5, bottom: 4, left: 5 }, rarity: 'uncommon' },
  { id: 110, name: 'Ashleaf', ranks: { top: 3, right: 4, bottom: 4, left: 3 }, rarity: 'uncommon' },
  { id: 111, name: 'Oakmoss', ranks: { top: 3, right: 3, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 112, name: 'Cedarbloom', ranks: { top: 3, right: 4, bottom: 2, left: 3 }, rarity: 'uncommon' },
  { id: 113, name: 'Magnolia', ranks: { top: 5, right: 2, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 114, name: 'Dahlia', ranks: { top: 5, right: 3, bottom: 4, left: 2 }, rarity: 'uncommon' },
  { id: 115, name: 'Poppy', ranks: { top: 4, right: 6, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 116, name: 'Marigold', ranks: { top: 1, right: 6, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 117, name: 'Buttercup', ranks: { top: 1, right: 6, bottom: 2, left: 6 }, rarity: 'uncommon' },
  { id: 118, name: 'Bluebell', ranks: { top: 3, right: 2, bottom: 6, left: 4 }, rarity: 'uncommon' },
  { id: 119, name: 'Foxglove', ranks: { top: 4, right: 6, bottom: 2, left: 3 }, rarity: 'uncommon' },
  { id: 120, name: 'Harebell', ranks: { top: 5, right: 3, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 121, name: 'Primrose', ranks: { top: 5, right: 4, bottom: 3, left: 3 }, rarity: 'uncommon' },
  { id: 122, name: 'Snapdragon', ranks: { top: 2, right: 4, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 123, name: 'Aster', ranks: { top: 2, right: 6, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 124, name: 'Zinnia', ranks: { top: 2, right: 5, bottom: 1, left: 4 }, rarity: 'uncommon' },
  { id: 125, name: 'Viola', ranks: { top: 4, right: 1, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 126, name: 'Petunia', ranks: { top: 5, right: 4, bottom: 2, left: 3 }, rarity: 'uncommon' },
  { id: 127, name: 'Hyacinth', ranks: { top: 6, right: 4, bottom: 3, left: 3 }, rarity: 'uncommon' },
  { id: 128, name: 'Crocus', ranks: { top: 6, right: 3, bottom: 3, left: 3 }, rarity: 'uncommon' },
  { id: 129, name: 'Tulip', ranks: { top: 4, right: 5, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 130, name: 'Iris', ranks: { top: 5, right: 2, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 131, name: 'Orchid', ranks: { top: 5, right: 4, bottom: 5, left: 2 }, rarity: 'uncommon' },
  { id: 132, name: 'Pansy', ranks: { top: 4, right: 4, bottom: 2, left: 6 }, rarity: 'uncommon' },
  { id: 133, name: 'Jasmine', ranks: { top: 2, right: 4, bottom: 4, left: 4 }, rarity: 'uncommon' },
  { id: 134, name: 'Lavender', ranks: { top: 1, right: 6, bottom: 2, left: 4 }, rarity: 'uncommon' },
  { id: 135, name: 'Rosemary', ranks: { top: 3, right: 1, bottom: 6, left: 5 }, rarity: 'uncommon' },
  { id: 136, name: 'Thyme', ranks: { top: 6, right: 1, bottom: 5, left: 3 }, rarity: 'uncommon' },
  { id: 137, name: 'Basil', ranks: { top: 3, right: 2, bottom: 5, left: 6 }, rarity: 'uncommon' },
  { id: 138, name: 'Sage', ranks: { top: 3, right: 6, bottom: 3, left: 1 }, rarity: 'uncommon' },
  { id: 139, name: 'Parsley', ranks: { top: 4, right: 4, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 140, name: 'Fennel', ranks: { top: 1, right: 6, bottom: 6, left: 3 }, rarity: 'uncommon' },
  { id: 141, name: 'Dill', ranks: { top: 3, right: 3, bottom: 4, left: 3 }, rarity: 'uncommon' },
  { id: 142, name: 'Chive', ranks: { top: 2, right: 4, bottom: 3, left: 5 }, rarity: 'uncommon' },
  { id: 143, name: 'Oregano', ranks: { top: 1, right: 6, bottom: 4, left: 1 }, rarity: 'uncommon' },
  { id: 144, name: 'Tarragon', ranks: { top: 2, right: 6, bottom: 1, left: 4 }, rarity: 'uncommon' },
  { id: 145, name: 'Anise', ranks: { top: 6, right: 4, bottom: 2, left: 1 }, rarity: 'uncommon' },
  { id: 146, name: 'Cardamom', ranks: { top: 4, right: 3, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 147, name: 'Cinnamon', ranks: { top: 5, right: 5, bottom: 1, left: 3 }, rarity: 'uncommon' },
  { id: 148, name: 'Ginger', ranks: { top: 1, right: 4, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 149, name: 'Nutmeg', ranks: { top: 6, right: 3, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 150, name: 'Saffie', ranks: { top: 4, right: 1, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 151, name: 'Tumeric', ranks: { top: 1, right: 4, bottom: 5, left: 5 }, rarity: 'uncommon' },
  { id: 152, name: 'Cayenne', ranks: { top: 4, right: 5, bottom: 1, left: 3 }, rarity: 'uncommon' },
  { id: 153, name: 'Paprika', ranks: { top: 1, right: 1, bottom: 5, left: 6 }, rarity: 'uncommon' },
  { id: 154, name: 'Cumin', ranks: { top: 6, right: 5, bottom: 3, left: 1 }, rarity: 'uncommon' },
  { id: 155, name: 'Coriander', ranks: { top: 4, right: 4, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 156, name: 'Clove', ranks: { top: 6, right: 1, bottom: 3, left: 3 }, rarity: 'uncommon' },
  { id: 157, name: 'Allspice', ranks: { top: 5, right: 3, bottom: 3, left: 3 }, rarity: 'uncommon' },
  { id: 158, name: 'Pimento', ranks: { top: 1, right: 4, bottom: 4, left: 6 }, rarity: 'uncommon' },
  { id: 159, name: 'Sumac', ranks: { top: 3, right: 6, bottom: 2, left: 4 }, rarity: 'uncommon' },
  { id: 160, name: 'Sesame', ranks: { top: 2, right: 3, bottom: 1, left: 6 }, rarity: 'uncommon' },
  { id: 161, name: 'Starflower', ranks: { top: 1, right: 6, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 162, name: 'Moonpetal', ranks: { top: 2, right: 6, bottom: 2, left: 3 }, rarity: 'uncommon' },
  { id: 163, name: 'Sundew', ranks: { top: 1, right: 5, bottom: 4, left: 5 }, rarity: 'uncommon' },
  { id: 164, name: 'Nightbloom', ranks: { top: 1, right: 5, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 165, name: 'Dawnbreeze', ranks: { top: 5, right: 2, bottom: 5, left: 4 }, rarity: 'uncommon' },
  { id: 166, name: 'Duskbell', ranks: { top: 5, right: 4, bottom: 5, left: 1 }, rarity: 'uncommon' },
  { id: 167, name: 'Twilight', ranks: { top: 2, right: 4, bottom: 6, left: 1 }, rarity: 'uncommon' },
  { id: 168, name: 'Gloaming', ranks: { top: 2, right: 3, bottom: 2, left: 5 }, rarity: 'uncommon' },
  { id: 169, name: 'Haze', ranks: { top: 3, right: 5, bottom: 2, left: 6 }, rarity: 'uncommon' },
  { id: 170, name: 'Vapor', ranks: { top: 5, right: 2, bottom: 3, left: 6 }, rarity: 'uncommon' },
  { id: 171, name: 'Cloudburst', ranks: { top: 4, right: 1, bottom: 6, left: 4 }, rarity: 'uncommon' },
  { id: 172, name: 'Sleet', ranks: { top: 6, right: 4, bottom: 1, left: 5 }, rarity: 'uncommon' },
  { id: 173, name: 'Drizzletail', ranks: { top: 5, right: 3, bottom: 5, left: 3 }, rarity: 'uncommon' },
  { id: 174, name: 'Steamvent', ranks: { top: 2, right: 2, bottom: 4, left: 6 }, rarity: 'uncommon' },
  { id: 175, name: 'Fogcrawler', ranks: { top: 6, right: 2, bottom: 5, left: 2 }, rarity: 'uncommon' },
  { id: 176, name: 'Mistwalker', ranks: { top: 3, right: 5, bottom: 3, left: 2 }, rarity: 'uncommon' },

  // Rare (ids 177-226)
  { id: 177, name: 'Abyssal', ranks: { top: 5, right: 6, bottom: 5, left: 3 }, rarity: 'rare' },
  { id: 178, name: 'Tidecaller', ranks: { top: 8, right: 3, bottom: 5, left: 2 }, rarity: 'rare' },
  { id: 179, name: 'Moonshadow', ranks: { top: 5, right: 5, bottom: 7, left: 2 }, rarity: 'rare' },
  { id: 180, name: 'Stormwarden', ranks: { top: 8, right: 3, bottom: 3, left: 8 }, rarity: 'rare' },
  { id: 181, name: 'Deeproot', ranks: { top: 4, right: 7, bottom: 4, left: 3 }, rarity: 'rare' },
  { id: 182, name: 'Crystalvein', ranks: { top: 8, right: 5, bottom: 6, left: 2 }, rarity: 'rare' },
  { id: 183, name: 'Nightfall', ranks: { top: 2, right: 5, bottom: 6, left: 5 }, rarity: 'rare' },
  { id: 184, name: 'Thornweaver', ranks: { top: 3, right: 4, bottom: 8, left: 7 }, rarity: 'rare' },
  { id: 185, name: 'Emberclaw', ranks: { top: 7, right: 7, bottom: 5, left: 2 }, rarity: 'rare' },
  { id: 186, name: 'Frostfang', ranks: { top: 2, right: 7, bottom: 5, left: 5 }, rarity: 'rare' },
  { id: 187, name: 'Ironbark', ranks: { top: 2, right: 3, bottom: 6, left: 7 }, rarity: 'rare' },
  { id: 188, name: 'Silverscale', ranks: { top: 8, right: 4, bottom: 3, left: 4 }, rarity: 'rare' },
  { id: 189, name: 'Goldmane', ranks: { top: 7, right: 6, bottom: 2, left: 7 }, rarity: 'rare' },
  { id: 190, name: 'Bronzewing', ranks: { top: 8, right: 3, bottom: 6, left: 2 }, rarity: 'rare' },
  { id: 191, name: 'Coppertail', ranks: { top: 3, right: 7, bottom: 8, left: 4 }, rarity: 'rare' },
  { id: 192, name: 'Steelheart', ranks: { top: 5, right: 4, bottom: 6, left: 2 }, rarity: 'rare' },
  { id: 193, name: 'Cobaltfin', ranks: { top: 3, right: 2, bottom: 5, left: 7 }, rarity: 'rare' },
  { id: 194, name: 'Chromatic', ranks: { top: 7, right: 5, bottom: 3, left: 3 }, rarity: 'rare' },
  { id: 195, name: 'Prismatic', ranks: { top: 8, right: 5, bottom: 2, left: 5 }, rarity: 'rare' },
  { id: 196, name: 'Opalescent', ranks: { top: 7, right: 4, bottom: 8, left: 3 }, rarity: 'rare' },
  { id: 197, name: 'Pearlshine', ranks: { top: 5, right: 7, bottom: 5, left: 2 }, rarity: 'rare' },
  { id: 198, name: 'Amethyst', ranks: { top: 2, right: 8, bottom: 2, left: 7 }, rarity: 'rare' },
  { id: 199, name: 'Emeraldine', ranks: { top: 6, right: 2, bottom: 7, left: 3 }, rarity: 'rare' },
  { id: 200, name: 'Rubythorn', ranks: { top: 6, right: 4, bottom: 5, left: 3 }, rarity: 'rare' },
  { id: 201, name: 'Topazglow', ranks: { top: 4, right: 3, bottom: 4, left: 7 }, rarity: 'rare' },
  { id: 202, name: 'Garnetflare', ranks: { top: 7, right: 2, bottom: 6, left: 5 }, rarity: 'rare' },
  { id: 203, name: 'Obsidian', ranks: { top: 4, right: 4, bottom: 5, left: 7 }, rarity: 'rare' },
  { id: 204, name: 'Onyx', ranks: { top: 6, right: 8, bottom: 2, left: 2 }, rarity: 'rare' },
  { id: 205, name: 'Turquoise', ranks: { top: 5, right: 2, bottom: 3, left: 8 }, rarity: 'rare' },
  { id: 206, name: 'Malachite', ranks: { top: 4, right: 4, bottom: 8, left: 6 }, rarity: 'rare' },
  { id: 207, name: 'Lazuli', ranks: { top: 8, right: 8, bottom: 3, left: 3 }, rarity: 'rare' },
  { id: 208, name: 'Aquamarine', ranks: { top: 8, right: 6, bottom: 2, left: 4 }, rarity: 'rare' },
  { id: 209, name: 'Beryl', ranks: { top: 3, right: 7, bottom: 4, left: 7 }, rarity: 'rare' },
  { id: 210, name: 'Zircon', ranks: { top: 8, right: 3, bottom: 6, left: 3 }, rarity: 'rare' },
  { id: 211, name: 'Agate', ranks: { top: 2, right: 2, bottom: 6, left: 7 }, rarity: 'rare' },
  { id: 212, name: 'Jasper', ranks: { top: 2, right: 7, bottom: 2, left: 6 }, rarity: 'rare' },
  { id: 213, name: 'Carnelian', ranks: { top: 7, right: 3, bottom: 8, left: 2 }, rarity: 'rare' },
  { id: 214, name: 'Moonstone', ranks: { top: 4, right: 7, bottom: 5, left: 3 }, rarity: 'rare' },
  { id: 215, name: 'Sunstone', ranks: { top: 2, right: 2, bottom: 7, left: 8 }, rarity: 'rare' },
  { id: 216, name: 'Bloodstone', ranks: { top: 4, right: 7, bottom: 6, left: 2 }, rarity: 'rare' },
  { id: 217, name: 'Thunderjaw', ranks: { top: 7, right: 3, bottom: 6, left: 3 }, rarity: 'rare' },
  { id: 218, name: 'Stormscale', ranks: { top: 5, right: 3, bottom: 6, left: 8 }, rarity: 'rare' },
  { id: 219, name: 'Windwalker', ranks: { top: 2, right: 5, bottom: 8, left: 7 }, rarity: 'rare' },
  { id: 220, name: 'Firebrand', ranks: { top: 7, right: 3, bottom: 2, left: 5 }, rarity: 'rare' },
  { id: 221, name: 'Iceveil', ranks: { top: 7, right: 4, bottom: 4, left: 3 }, rarity: 'rare' },
  { id: 222, name: 'Voidtouched', ranks: { top: 8, right: 3, bottom: 2, left: 6 }, rarity: 'rare' },
  { id: 223, name: 'Netherbloom', ranks: { top: 8, right: 2, bottom: 5, left: 6 }, rarity: 'rare' },
  { id: 224, name: 'Spiritfang', ranks: { top: 6, right: 5, bottom: 4, left: 5 }, rarity: 'rare' },
  { id: 225, name: 'Soulreaver', ranks: { top: 6, right: 8, bottom: 6, left: 2 }, rarity: 'rare' },
  { id: 226, name: 'Doomhowl', ranks: { top: 3, right: 8, bottom: 4, left: 5 }, rarity: 'rare' },

  // Epic (ids 227-246)
  { id: 227, name: 'Oblivion', ranks: { top: 6, right: 3, bottom: 9, left: 4 }, rarity: 'epic' },
  { id: 228, name: 'Cataclysm', ranks: { top: 4, right: 9, bottom: 9, left: 4 }, rarity: 'epic' },
  { id: 229, name: 'Apocalypse', ranks: { top: 8, right: 9, bottom: 3, left: 3 }, rarity: 'epic' },
  { id: 230, name: 'Ragnarok', ranks: { top: 7, right: 3, bottom: 4, left: 9 }, rarity: 'epic' },
  { id: 231, name: 'Armageddon', ranks: { top: 6, right: 4, bottom: 9, left: 4 }, rarity: 'epic' },
  { id: 232, name: 'Leviathan', ranks: { top: 7, right: 9, bottom: 7, left: 3 }, rarity: 'epic' },
  { id: 233, name: 'Behemoth', ranks: { top: 4, right: 3, bottom: 6, left: 9 }, rarity: 'epic' },
  { id: 234, name: 'Colossus', ranks: { top: 6, right: 8, bottom: 4, left: 4 }, rarity: 'epic' },
  { id: 235, name: 'Juggernaut', ranks: { top: 7, right: 7, bottom: 4, left: 7 }, rarity: 'epic' },
  { id: 236, name: 'Titan', ranks: { top: 9, right: 3, bottom: 6, left: 4 }, rarity: 'epic' },
  { id: 237, name: 'Seraphim', ranks: { top: 8, right: 8, bottom: 3, left: 3 }, rarity: 'epic' },
  { id: 238, name: 'Nephilim', ranks: { top: 9, right: 9, bottom: 4, left: 5 }, rarity: 'epic' },
  { id: 239, name: 'Archon', ranks: { top: 9, right: 3, bottom: 8, left: 4 }, rarity: 'epic' },
  { id: 240, name: 'Sovereign', ranks: { top: 3, right: 6, bottom: 8, left: 9 }, rarity: 'epic' },
  { id: 241, name: 'Imperator', ranks: { top: 9, right: 3, bottom: 8, left: 3 }, rarity: 'epic' },
  { id: 242, name: 'Nexus', ranks: { top: 8, right: 3, bottom: 8, left: 8 }, rarity: 'epic' },
  { id: 243, name: 'Singularity', ranks: { top: 4, right: 9, bottom: 4, left: 7 }, rarity: 'epic' },
  { id: 244, name: 'Infinity', ranks: { top: 8, right: 9, bottom: 6, left: 3 }, rarity: 'epic' },
  { id: 245, name: 'Eternity', ranks: { top: 4, right: 4, bottom: 7, left: 8 }, rarity: 'epic' },
  { id: 246, name: 'Genesis', ranks: { top: 6, right: 7, bottom: 8, left: 3 }, rarity: 'epic' },

  // Legendary (ids 247-256) — the ten original legendaries re-issued from ids 41-50 (oldId in the JSON), identical ranks
  { id: 247, name: 'Eclipse', ranks: { top: 6, right: 7, bottom: 3, left: 7 }, rarity: 'legendary' },
  { id: 248, name: 'Kaleidoscope', ranks: { top: 6, right: 5, bottom: 8, left: 4 }, rarity: 'legendary' },
  { id: 249, name: 'Twinned', ranks: { top: 6, right: 5, bottom: 6, left: 6 }, rarity: 'legendary' },
  { id: 250, name: 'Sparkletail', ranks: { top: 3, right: 6, bottom: 7, left: 8 }, rarity: 'legendary' },
  { id: 251, name: 'Riddler', ranks: { top: 7, right: 6, bottom: 5, left: 6 }, rarity: 'legendary' },
  { id: 252, name: 'Rosita', ranks: { top: 3, right: 10, bottom: 2, left: 1 }, rarity: 'legendary' },
  { id: 253, name: 'Brooklet', ranks: { top: 6, right: 2, bottom: 6, left: 7 }, rarity: 'legendary' },
  { id: 254, name: 'Whisper', ranks: { top: 5, right: 5, bottom: 7, left: 6 }, rarity: 'legendary' },
  { id: 255, name: 'Misty', ranks: { top: 7, right: 7, bottom: 4, left: 2 }, rarity: 'legendary' },
  { id: 256, name: 'Lerma', ranks: { top: 7, right: 2, bottom: 7, left: 4 }, rarity: 'legendary' },
];

/**
 * Pack card ranks into a single number matching the on-chain format.
 * Format: top + right*16 + bottom*256 + left*4096
 */
export function packRanks(top: number, right: number, bottom: number, left: number): number {
  return top + right * 16 + bottom * 256 + left * 4096;
}

/**
 * Unpack a packed ranks number into individual ranks.
 */
export function unpackRanks(packed: number): { top: number; right: number; bottom: number; left: number } {
  return {
    top: packed & 0xf,
    right: (packed >> 4) & 0xf,
    bottom: (packed >> 8) & 0xf,
    left: (packed >> 12) & 0xf,
  };
}

/**
 * Verify that all cards in CARD_DATABASE have consistent ranks.
 * Returns an array of error messages (empty if all consistent).
 * This is used by the deploy script to verify rank data before deployment.
 */
export function verifyCardRankConsistency(): string[] {
  const errors: string[] = [];
  for (const card of CARD_DATABASE) {
    const { top, right, bottom, left } = card.ranks;
    // Verify ranks are in valid range 1-10
    for (const [name, val] of [['top', top], ['right', right], ['bottom', bottom], ['left', left]] as const) {
      if (val < 1 || val > 10) {
        errors.push(`Card ${card.id} (${card.name}): ${name} rank ${val} out of range 1-10`);
      }
    }
    // Verify pack/unpack round-trip
    const packed = packRanks(top, right, bottom, left);
    const unpacked = unpackRanks(packed);
    if (unpacked.top !== top || unpacked.right !== right || unpacked.bottom !== bottom || unpacked.left !== left) {
      errors.push(`Card ${card.id} (${card.name}): rank pack/unpack mismatch`);
    }
  }
  return errors;
}

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
