#!/usr/bin/env node
/**
 * Tutorial Card Art Generator (Timmy + Xochitl)
 *
 * Generates unique card illustrations for tutorial-only cards using DALL-E 3.
 * Then composites them into final card PNGs using the same pipeline as
 * generate-card-graphics.mjs.
 *
 * Usage:  node scripts/generate-timmy-art.mjs
 * Output: packages/frontend/public/cards/card-<id>.png       (raw art)
 *         packages/frontend/public/cards/final/card-<id>.png  (composited card)
 */

import OpenAI from 'openai';
import sharp from 'sharp';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

// ── Config ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const API_KEY_PATH = '/Users/zac/aztec-triple-triad/OPEN_API_KEY.txt';
const CARDS_DIR = path.resolve(ROOT, 'packages/frontend/public/cards');
const OUTPUT_DIR = path.resolve(ROOT, 'packages/frontend/public/cards/final');
const CARD_FRONTS_DIR = path.resolve(ROOT, '../Swamp_Source_Files/CardFronts');

const apiKey = readFileSync(API_KEY_PATH, 'utf-8').trim();
const openai = new OpenAI({ apiKey });

// ── Tutorial card definitions ───────────────────────────────────────────

const TUTORIAL_CARDS = [
  // Xochitl tutorial cards (IDs 101-110)
  { id: 101, name: 'Stone Lizard',  ranks: { top: 2, right: 5, bottom: 2, left: 3 },
    description: 'A squat, heavy-bodied lizard with rough stone-grey scales and moss growing between the cracks. Slow and ancient, resting on a flat rock in a murky swamp. Earthy brown-grey tones, dim ambient light.' },
  { id: 102, name: 'Vine Creeper',  ranks: { top: 4, right: 4, bottom: 6, left: 1 },
    description: 'A sinuous green creature made of living vines and creeping tendrils. Small yellow eyes peek through the leaves. Wrapped around a dead tree in a foggy swamp. Deep greens and browns, misty atmosphere.' },
  { id: 103, name: 'River Drake',   ranks: { top: 7, right: 3, bottom: 5, left: 7 },
    description: 'A sleek, serpentine water dragon with iridescent blue-green scales and translucent fin-like wings. Gliding just above dark swamp water, creating ripples. Cool blue-teal palette with silver highlights.' },
  { id: 104, name: 'Marsh Hawk',    ranks: { top: 5, right: 6, bottom: 4, left: 6 },
    description: 'A fierce hawk with dark brown plumage and golden-amber eyes, adapted to swamp hunting. Sharp talons and a hooked beak. Perched on a dead cypress branch above murky water. Warm amber and brown tones.' },
  { id: 105, name: 'Storm Elder',   ranks: { top: 8, right: 8, bottom: 6, left: 7 },
    description: 'An ancient, massive creature wreathed in crackling purple lightning. A tortoise-like body with crystalline spines along its shell that arc with electricity. Dramatic storm clouds, violet and silver energy.' },
  { id: 106, name: 'Swamp Sprite',  ranks: { top: 3, right: 2, bottom: 4, left: 2 },
    description: 'A tiny luminous fairy-like creature with dragonfly wings, glowing soft green. Sitting on a lily pad, leaving tiny sparkle trails. Warm green bioluminescence, cozy swamp night scene.' },
  { id: 107, name: 'Reed Dancer',   ranks: { top: 5, right: 1, bottom: 3, left: 5 },
    description: 'A graceful crane-like bird with long legs and flowing tail feathers, standing among tall reeds. Elegant dance pose, feathers trailing through mist. Soft whites and pale golds, dawn light.' },
  { id: 108, name: 'Mud Golem',     ranks: { top: 6, right: 6, bottom: 2, left: 4 },
    description: 'A hulking figure made of compacted swamp mud and clay, with glowing amber eyes. Chunks of vegetation and small rocks embedded in its body. Dark earthen tones with amber glow, imposing presence.' },
  { id: 109, name: 'Bog Witch',     ranks: { top: 7, right: 3, bottom: 7, left: 5 },
    description: 'A mysterious hooded figure with pale green skin and glowing violet eyes. Gnarled staff topped with a glowing crystal. Standing in a misty bog with floating spell sigils. Purple and green mystical palette.' },
  { id: 110, name: 'Swamp King',    ranks: { top: 8, right: 7, bottom: 8, left: 6 },
    description: 'A massive armored crocodilian creature with a crown of twisted thorns and barnacles. Ancient and terrifying, half-submerged in black water with only eyes and crown visible. Dark dramatic lighting, gold and black.' },

  // Timmy tutorial cards (IDs 201-205)
  { id: 201, name: "Timmy's Friend",       ranks: { top: 1, right: 2, bottom: 1, left: 1 },
    description: 'A tiny, adorable but utterly unremarkable tadpole with a goofy grin and one oversized eye. Floating in a puddle looking proud of itself. Cute and pathetic, warm pastel greens, simple and silly.' },
  { id: 202, name: "Timmy's Other Friend", ranks: { top: 2, right: 1, bottom: 1, left: 1 },
    description: 'Another tiny tadpole, slightly different — this one has a little bow tie made of seaweed and looks absurdly confident. Standing on a pebble like it is on a stage. Cute and silly, warm pastels.' },
  { id: 203, name: 'Timmy',                ranks: { top: 2, right: 2, bottom: 2, left: 2 },
    description: 'A small enthusiastic boy-axolotl wearing an oversized adventurer hat that falls over his eyes. Puffing out his chest proudly, holding a tiny wooden sword. Bright cheerful colors, blue and orange, comical bravery.' },
  { id: 204, name: 'Old Boot',             ranks: { top: 1, right: 1, bottom: 1, left: 1 },
    description: 'A soggy, decrepit leather boot half-submerged in swamp mud. A small frog sits inside it looking confused. Flies buzzing around. Comedic and gross, brown and green muck tones, absurd and pathetic.' },
  { id: 205, name: 'Lost Cat',             ranks: { top: 1, right: 1, bottom: 1, left: 1 },
    description: 'A bewildered orange tabby cat sitting in the middle of a swamp, completely out of place. Wet fur, wide startled eyes, a lily pad on its head. Comedic fish-out-of-water scene, warm orange against swamp greens.' },
];

// ── DALL-E generation ───────────────────────────────────────────────────

async function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        writeFileSync(outputPath, buffer);
        resolve(outputPath);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateArt(card) {
  const artPath = path.join(CARDS_DIR, `card-${card.id}.png`);

  if (existsSync(artPath)) {
    console.log(`  ~ Card ${card.id} (${card.name}) — art exists, skipping DALL-E`);
    return artPath;
  }

  const prompt = `Fantasy trading card illustration, painterly oil painting style with dramatic chiaroscuro lighting. ${card.description} Edge-to-edge painting with no border, no frame, no vignette. No text, no words, no letters, no numbers, no watermark, no UI elements.`;

  console.log(`  > Card ${card.id} (${card.name}) — generating with DALL-E 3...`);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    quality: 'standard',
  });

  const imageUrl = response.data[0].url;
  await downloadImage(imageUrl, artPath);
  console.log(`  + Card ${card.id} (${card.name}) — art saved`);
  return artPath;
}

// ── Card compositing (same as generate-card-graphics.mjs) ───────────────

const CARD_W = 978;
const CARD_H = 1387;
const CANVAS_W = CARD_W;
const CANVAS_H = CARD_H;

const OVAL_X = 187;
const OVAL_Y = 136;
const OVAL_W = 596;
const OVAL_H = 804;
const OVAL_CX = OVAL_X + OVAL_W / 2;
const OVAL_CY = OVAL_Y + OVAL_H / 2;

const AXO_W = OVAL_W + 40;
const AXO_H = OVAL_H + 40;
const AXO_LEFT = Math.round(OVAL_CX - AXO_W / 2);
const AXO_TOP = Math.round(OVAL_CY - AXO_H / 2);

const ROUNDEL_R = 125;
const ROUNDEL_POSITIONS = {
  top:    { x: 420, y: 8 },
  right:  { x: 801, y: 482 },
  bottom: { x: 420, y: 914 },
  left:   { x: 44,  y: 482 },
};
const ROUNDEL_CENTERS = {
  top:    { x: ROUNDEL_POSITIONS.top.x + ROUNDEL_R,    y: ROUNDEL_POSITIONS.top.y + ROUNDEL_R },
  right:  { x: ROUNDEL_POSITIONS.right.x + ROUNDEL_R,  y: ROUNDEL_POSITIONS.right.y + ROUNDEL_R },
  bottom: { x: ROUNDEL_POSITIONS.bottom.x + ROUNDEL_R, y: ROUNDEL_POSITIONS.bottom.y + ROUNDEL_R },
  left:   { x: ROUNDEL_POSITIONS.left.x + ROUNDEL_R,   y: ROUNDEL_POSITIONS.left.y + ROUNDEL_R },
};

const NAME_X = 149;
const NAME_Y = 1105;
const NAME_W = 686;
const NAME_H = 180;

function formatRank(rank) {
  return rank === 10 ? 'A' : String(rank);
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function makeStatsSvg(ranks) {
  const fontSize = 220;
  const strokeWidth = 16;

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
  let fontSize = 112;
  if (name.length > 10) fontSize = 96;
  if (name.length > 13) fontSize = 80;
  if (name.length > 17) fontSize = 64;

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
        font-family="Impact, 'Arial Black', sans-serif"
        font-size="${fontSize}"
        font-weight="bold"
        text-anchor="middle"
        dominant-baseline="central"
        fill="white"
        stroke="black"
        stroke-width="8"
        paint-order="stroke fill"
        filter="url(#ds)"
      >${escapeXml(name)}</text>
    </svg>
  `);
}

async function compositeCard(card) {
  const artFile = path.join(CARDS_DIR, `card-${card.id}.png`);
  const outputFile = path.join(OUTPUT_DIR, `card-${card.id}.png`);
  // Tutorial cards all use the common template
  const templateFile = path.join(CARD_FRONTS_DIR, 'card_common.png');

  if (!existsSync(artFile)) {
    console.log(`  ! Card ${card.id} — no art file, skipping composite`);
    return null;
  }

  if (!existsSync(templateFile)) {
    console.log(`  ! Card ${card.id} — no template file at ${templateFile}, skipping composite`);
    return null;
  }

  const artResized = await sharp(artFile)
    .resize(AXO_W, AXO_H, { fit: 'cover' })
    .toBuffer();

  const templateResized = await sharp(templateFile)
    .resize(CARD_W, CARD_H, { fit: 'fill' })
    .toBuffer();

  const statsSvg = makeStatsSvg(card.ranks);
  const nameSvg = makeNameSvg(card.name);

  const result = await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: artResized, left: AXO_LEFT, top: AXO_TOP },
      { input: templateResized, left: 0, top: 0 },
      { input: statsSvg, left: 0, top: 0 },
      { input: nameSvg, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  await sharp(result).toFile(outputFile);
  console.log(`  + Card ${card.id} (${card.name}) -> ${path.basename(outputFile)}`);
  return outputFile;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Tutorial Card Art Generator');
  console.log('===========================\n');

  if (!existsSync(CARDS_DIR)) await mkdir(CARDS_DIR, { recursive: true });
  if (!existsSync(OUTPUT_DIR)) await mkdir(OUTPUT_DIR, { recursive: true });

  // Step 1: Generate DALL-E art for each card
  console.log('Step 1: Generating DALL-E art...\n');
  let artSuccess = 0;
  let artFailed = 0;

  for (const card of TUTORIAL_CARDS) {
    try {
      await generateArt(card);
      artSuccess++;
      // Small delay between API calls
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  x Card ${card.id} (${card.name}): ${err.message}`);
      artFailed++;
    }
  }
  console.log(`\nArt: ${artSuccess} generated, ${artFailed} failed\n`);

  // Step 2: Composite into final card PNGs
  console.log('Step 2: Compositing final cards...\n');
  let compSuccess = 0;
  let compFailed = 0;

  for (const card of TUTORIAL_CARDS) {
    try {
      const result = await compositeCard(card);
      if (result) compSuccess++;
    } catch (err) {
      console.error(`  x Card ${card.id} (${card.name}): ${err.message}`);
      compFailed++;
    }
  }
  console.log(`\nComposite: ${compSuccess} generated, ${compFailed} failed`);
}

main().catch(console.error);
