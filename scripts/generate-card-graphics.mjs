#!/usr/bin/env node
/**
 * Card Graphic Generator
 *
 * Composites final card PNGs:
 *   1. Axolotl art visible through the oval
 *   2. Card frame template on top (contains built-in roundels)
 *   3. Stat numbers rendered inside the 4 roundels
 *   4. Card name in the bottom nameplate
 *
 * The card frames already have 4 blue circular roundels built in.
 * We just render the stat values on top of them.
 *
 * Usage:  node scripts/generate-card-graphics.mjs
 * Output: packages/frontend/public/cards/final/card-<id>.png
 */

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ── Card database ───────────────────────────────────────────────────────

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

function getCardTemplate(id) {
  if (id <= 10) return 'card_common.png';
  if (id <= 20) return 'card_basic.png';
  if (id <= 30) return 'card_rare.png';
  if (id <= 40) return 'card_epic.png';
  return 'card_legendary.png';
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── Dimensions ──────────────────────────────────────────────────────────

const CARD_W = 978;
const CARD_H = 1387;

// Canvas = card size (no extra margins — roundels are inside the card now)
const CANVAS_W = CARD_W;
const CANVAS_H = CARD_H;

// Oval position and size (for axolotl art placement)
const OVAL_X = 187;
const OVAL_Y = 136;
const OVAL_W = 596;
const OVAL_H = 804;
const OVAL_CX = OVAL_X + OVAL_W / 2;   // 485
const OVAL_CY = OVAL_Y + OVAL_H / 2;   // 538

// Axolotl art — sized to cover the oval
const AXO_W = OVAL_W + 40;  // slight bleed for full coverage
const AXO_H = OVAL_H + 40;
const AXO_LEFT = Math.round(OVAL_CX - AXO_W / 2);
const AXO_TOP = Math.round(OVAL_CY - AXO_H / 2);

// Built-in roundel positions (top-left of 250x250 bounding box, radius 125px)
const ROUNDEL_R = 125;

const ROUNDEL_POSITIONS = {
  top:    { x: 420, y: 8 },
  right:  { x: 801, y: 482 },
  bottom: { x: 420, y: 914 },
  left:   { x: 44,  y: 482 },
};

// Roundel centers (for number placement)
const ROUNDEL_CENTERS = {
  top:    { x: ROUNDEL_POSITIONS.top.x + ROUNDEL_R,    y: ROUNDEL_POSITIONS.top.y + ROUNDEL_R },
  right:  { x: ROUNDEL_POSITIONS.right.x + ROUNDEL_R,  y: ROUNDEL_POSITIONS.right.y + ROUNDEL_R },
  bottom: { x: ROUNDEL_POSITIONS.bottom.x + ROUNDEL_R, y: ROUNDEL_POSITIONS.bottom.y + ROUNDEL_R },
  left:   { x: ROUNDEL_POSITIONS.left.x + ROUNDEL_R,   y: ROUNDEL_POSITIONS.left.y + ROUNDEL_R },
};

// Name rectangle (relative to card origin)
const NAME_X = 149;
const NAME_Y = 1105;
const NAME_W = 686;
const NAME_H = 180;

// ── SVG generators ──────────────────────────────────────────────────────

function makeStatsSvg(ranks) {
  const fontSize = 110;
  const strokeWidth = 8;

  function statText(value, cx, cy) {
    const text = formatRank(value);
    return `
      <text x="${cx - 62}" y="${cy - 62}"
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
    <svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}">
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

function makeNameSvg(name) {
  let fontSize = 56;
  if (name.length > 10) fontSize = 48;
  if (name.length > 13) fontSize = 40;

  const cx = NAME_X + NAME_W / 2;
  const cy = NAME_Y + NAME_H / 2;

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}">
      <defs>
        <filter id="ds" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.7"/>
        </filter>
      </defs>
      <text x="${cx}" y="${cy}"
        font-family="Georgia, 'Palatino Linotype', serif"
        font-size="${fontSize}"
        font-weight="bold"
        text-anchor="middle"
        dominant-baseline="central"
        fill="#f0e6c8"
        stroke="#2a1f10"
        stroke-width="3"
        paint-order="stroke fill"
        filter="url(#ds)"
      >${escapeXml(name)}</text>
    </svg>
  `);
}

// ── Paths ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const CARD_FRONTS_DIR = path.resolve(ROOT, '../Swamp_Source_Files/CardFronts');
const AXOLOTL_DIR = path.resolve(ROOT, 'packages/frontend/public/cards');
const OUTPUT_DIR = path.resolve(ROOT, 'packages/frontend/public/cards/final');

// ── Generate one card ───────────────────────────────────────────────────

async function generateCard(card) {
  const templateFile = path.join(CARD_FRONTS_DIR, getCardTemplate(card.id));
  const axolotlFile = path.join(AXOLOTL_DIR, `card-${card.id}.png`);
  const outputFile = path.join(OUTPUT_DIR, `card-${card.id}.png`);

  // Load and resize assets
  const axolotlResized = await sharp(axolotlFile)
    .resize(AXO_W, AXO_H, { fit: 'cover' })
    .toBuffer();

  const templateResized = await sharp(templateFile)
    .resize(CARD_W, CARD_H, { fit: 'fill' })
    .toBuffer();

  const statsSvg = makeStatsSvg(card.ranks);
  const nameSvg = makeNameSvg(card.name);

  // Composite layers:
  //   1. Axolotl art (behind the oval)
  //   2. Card frame template (contains built-in roundels)
  //   3. Stat numbers on top of roundels
  //   4. Name text on the nameplate
  const result = await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: axolotlResized, left: AXO_LEFT, top: AXO_TOP },
      { input: templateResized, left: 0, top: 0 },
      { input: statsSvg, left: 0, top: 0 },
      { input: nameSvg, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  await sharp(result).toFile(outputFile);
  return outputFile;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Card Graphic Generator');
  console.log('======================\n');

  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  console.log(`Card: ${CARD_W}x${CARD_H}`);
  console.log(`Oval: ${OVAL_W}x${OVAL_H} at (${OVAL_X}, ${OVAL_Y})`);
  console.log(`Roundel centers: T(${ROUNDEL_CENTERS.top.x},${ROUNDEL_CENTERS.top.y}) R(${ROUNDEL_CENTERS.right.x},${ROUNDEL_CENTERS.right.y}) B(${ROUNDEL_CENTERS.bottom.x},${ROUNDEL_CENTERS.bottom.y}) L(${ROUNDEL_CENTERS.left.x},${ROUNDEL_CENTERS.left.y})`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  let success = 0;
  let failed = 0;

  for (const card of CARD_DATABASE) {
    try {
      const output = await generateCard(card);
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
