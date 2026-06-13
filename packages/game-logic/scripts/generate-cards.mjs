#!/usr/bin/env node
// Regenerates src/cards.ts from the canonical card database
// (scripts/card-database-256.json at the repo root — the same source that
// generates circuits/card_data/src/lib.nr and packages/frontend/src/cards.ts).
//
// Usage, from packages/game-logic:  npm run generate:cards
//
// tests/cards.test.ts pins the generated file against the JSON, so a stale
// or hand-edited cards.ts fails the suite.
import { readFileSync, writeFileSync } from 'node:fs';

const jsonUrl = new URL('../../../scripts/card-database-256.json', import.meta.url);
const outUrl = new URL('../src/cards.ts', import.meta.url);

const cards = JSON.parse(readFileSync(jsonUrl, 'utf8'));
if (cards.length !== 256) {
  throw new Error(`Expected 256 cards in ${jsonUrl.pathname}, got ${cards.length}`);
}

const BAND_NOTES = {
  common: 'Common (ids 1-10)',
  uncommon: 'Uncommon (ids 11-176)',
  rare: 'Rare (ids 177-226)',
  epic: 'Epic (ids 227-246)',
  legendary:
    'Legendary (ids 247-256) — the ten original legendaries re-issued from ids 41-50 (oldId in the JSON), identical ranks',
};

const lines = [];
let previousRarity = null;
for (const card of cards) {
  if (typeof card.id !== 'number' || typeof card.name !== 'string' || !card.ranks) {
    throw new Error(`Malformed card entry: ${JSON.stringify(card)}`);
  }
  if (card.rarity !== previousRarity) {
    if (!(card.rarity in BAND_NOTES)) {
      throw new Error(`Card ${card.id}: unknown rarity '${card.rarity}'`);
    }
    lines.push(`\n  // ${BAND_NOTES[card.rarity]}`);
    previousRarity = card.rarity;
  }
  const { top, right, bottom, left } = card.ranks;
  const name = card.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  lines.push(
    `  { id: ${card.id}, name: '${name}', ranks: { top: ${top}, right: ${right}, bottom: ${bottom}, left: ${left} }, rarity: '${card.rarity}' },`
  );
}

const output = `import { Card } from './types.js';

/**
 * Card database for Axolotl Arena — GENERATED FILE, DO NOT HAND-EDIT.
 *
 * Source of truth: scripts/card-database-256.json (repo root), which also
 * generates circuits/card_data/src/lib.nr (what proofs enforce) and
 * packages/frontend/src/cards.ts (what players see). Regenerate with
 * \`npm run generate:cards\` in packages/game-logic; tests/cards.test.ts
 * pins this file against the JSON.
 *
 * Each card has ranks 1-10 (A=10) for top, right, bottom, left. Rarity bands
 * are positional by id, mirroring CARDS_PER_POOL in triple_triad_nft.
 */
export const CARD_DATABASE: Card[] = [${lines.join('\n')}
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
        errors.push(\`Card \${card.id} (\${card.name}): \${name} rank \${val} out of range 1-10\`);
      }
    }
    // Verify pack/unpack round-trip
    const packed = packRanks(top, right, bottom, left);
    const unpacked = unpackRanks(packed);
    if (unpacked.top !== top || unpacked.right !== right || unpacked.bottom !== bottom || unpacked.left !== left) {
      errors.push(\`Card \${card.id} (\${card.name}): rank pack/unpack mismatch\`);
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
    if (!card) throw new Error(\`Card with id \${id} not found\`);
    return { ...card };
  });
}
`;

writeFileSync(outUrl, output);
console.log(`Wrote ${cards.length} cards to ${outUrl.pathname}`);
