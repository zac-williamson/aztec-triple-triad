#!/usr/bin/env node
/**
 * Board Card Graphic Generator
 *
 * Generates square card graphics for display on the game board crates.
 * Uses card_on_board.png (oval frame with 4 roundels) on a TRANSPARENT background.
 * Owner color (blue/red) is applied dynamically in the 3D scene via a colored quad.
 *
 * For each card, generates one version:
 *   - card-<id>-board.png  (transparent background)
 *
 * Layers:
 *   1. Transparent background
 *   2. Axolotl art in the oval
 *   3. card_on_board.png frame on top
 *   4. Stat numbers on the roundels
 *
 * Usage:  node scripts/generate-board-cards.mjs
 * Output: packages/frontend/public/cards/board/card-<id>-board.png
 */

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ── Card database (same as generate-card-graphics.mjs) ──────────────────

const CARD_DATABASE = [
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

function formatRank(rank) {
  return rank === 10 ? 'A' : String(rank);
}

// ── Dimensions (card_on_board.png is 1052x1052) ────────────────────────

const BOARD_SIZE = 1052;

// Oval position and size
const OVAL_X = 221;
const OVAL_Y = 121;
const OVAL_W = 611;
const OVAL_H = 803;
const OVAL_CX = OVAL_X + OVAL_W / 2;   // 526.5
const OVAL_CY = OVAL_Y + OVAL_H / 2;   // 522.5

// Axolotl art — sized to fill the oval, clipped to an ellipse
// The ellipse aspect ratio: vertical = 1.314 * horizontal
const AXO_W = OVAL_W + 20;   // slight bleed
const AXO_H = OVAL_H + 20;
const AXO_LEFT = Math.round(OVAL_CX - AXO_W / 2);
const AXO_TOP = Math.round(OVAL_CY - AXO_H / 2);

// Roundel positions (top-left of 125x125 bounding box)
const ROUNDEL_SIZE = 125;
const ROUNDEL_POSITIONS = {
  top:    { x: 462, y: 7 },
  right:  { x: 828, y: 416 },
  bottom: { x: 462, y: 906 },
  left:   { x: 99,  y: 416 },
};

// Roundel centers (for number placement)
const ROUNDEL_CENTERS = {
  top:    { x: ROUNDEL_POSITIONS.top.x + ROUNDEL_SIZE / 2,    y: ROUNDEL_POSITIONS.top.y + ROUNDEL_SIZE / 2 },
  right:  { x: ROUNDEL_POSITIONS.right.x + ROUNDEL_SIZE / 2,  y: ROUNDEL_POSITIONS.right.y + ROUNDEL_SIZE / 2 },
  bottom: { x: ROUNDEL_POSITIONS.bottom.x + ROUNDEL_SIZE / 2, y: ROUNDEL_POSITIONS.bottom.y + ROUNDEL_SIZE / 2 },
  left:   { x: ROUNDEL_POSITIONS.left.x + ROUNDEL_SIZE / 2,   y: ROUNDEL_POSITIONS.left.y + ROUNDEL_SIZE / 2 },
};

// ── SVG generators ──────────────────────────────────────────────────────

function makeStatsSvg(ranks) {
  const fontSize = 70;
  const strokeWidth = 5;

  function statText(value, cx, cy) {
    const text = formatRank(value);
    return `
      <text x="${cx}" y="${cy}"
        font-family="Impact, 'Arial Black', sans-serif"
        font-size="${fontSize}"
        font-weight="bold"
        text-anchor="middle"
        dominant-baseline="central"
        fill="white"
        stroke="black"
        stroke-width="${strokeWidth}"
        paint-order="stroke fill"
        filter="url(#ds)"
      >${text}</text>`;
  }

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_SIZE}" height="${BOARD_SIZE}">
      <defs>
        <filter id="ds" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.9"/>
        </filter>
      </defs>
      ${statText(ranks.top,    ROUNDEL_CENTERS.top.x,    ROUNDEL_CENTERS.top.y)}
      ${statText(ranks.right,  ROUNDEL_CENTERS.right.x,  ROUNDEL_CENTERS.right.y)}
      ${statText(ranks.bottom, ROUNDEL_CENTERS.bottom.x, ROUNDEL_CENTERS.bottom.y)}
      ${statText(ranks.left,   ROUNDEL_CENTERS.left.x,   ROUNDEL_CENTERS.left.y)}
    </svg>
  `);
}

// ── Paths ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const CARD_FRONTS_DIR = path.resolve(ROOT, '../Swamp_Source_Files/CardFronts');
const FRAME_PATH = path.join(CARD_FRONTS_DIR, 'card_on_board.png');
const AXOLOTL_DIR = path.resolve(ROOT, 'packages/frontend/public/cards');
const OUTPUT_DIR = path.resolve(ROOT, 'packages/frontend/public/cards/board');

// ── Generate one board card (transparent background) ────────────────────

async function generateBoardCard(card, frameBuffer) {
  const axolotlFile = path.join(AXOLOTL_DIR, `card-${card.id}.png`);
  const outputFile = path.join(OUTPUT_DIR, `card-${card.id}-board.png`);

  // Axolotl art sized to fill the oval, then clipped to an ellipse
  const axolotlResized = await sharp(axolotlFile)
    .resize(AXO_W, AXO_H, { fit: 'cover' })
    .toBuffer();

  // Create ellipse mask: vertical dimension 1.314x horizontal
  const ellipseRx = Math.round(AXO_W / 2);
  const ellipseRy = Math.round(ellipseRx * 1.314);
  const ellipseMask = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${AXO_W}" height="${AXO_H}">
      <ellipse cx="${AXO_W / 2}" cy="${AXO_H / 2}" rx="${ellipseRx}" ry="${ellipseRy}" fill="white"/>
    </svg>
  `);

  // Apply ellipse mask to clip axolotl
  const axolotlClipped = await sharp(axolotlResized)
    .composite([{ input: ellipseMask, blend: 'dest-in' }])
    .toBuffer();

  const statsSvg = makeStatsSvg(card.ranks);

  // Composite layers:
  //   1. Transparent background
  //   2. Axolotl art (behind the oval)
  //   3. Frame (card_on_board.png — oval border + roundels, transparent elsewhere)
  //   4. Stat numbers on roundels
  const result = await sharp({
    create: {
      width: BOARD_SIZE,
      height: BOARD_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: axolotlClipped, left: AXO_LEFT, top: AXO_TOP },
      { input: frameBuffer, left: 0, top: 0 },
      { input: statsSvg, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  await sharp(result).toFile(outputFile);
  return outputFile;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Board Card Graphic Generator');
  console.log('============================\n');

  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  // Load frame once
  const frameBuffer = await sharp(FRAME_PATH)
    .resize(BOARD_SIZE, BOARD_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  console.log(`Frame: ${BOARD_SIZE}x${BOARD_SIZE}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  let success = 0;
  let failed = 0;

  for (const card of CARD_DATABASE) {
    try {
      const output = await generateBoardCard(card, frameBuffer);
      console.log(`  + Card ${card.id} (${card.name}) -> ${path.basename(output)}`);
      success++;
    } catch (err) {
      console.error(`  x Card ${card.id} (${card.name}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} generated, ${failed} failed`);
}

main().catch(console.error);
