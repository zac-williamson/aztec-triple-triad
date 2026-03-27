#!/usr/bin/env node
/**
 * Generate 256-card database for Axolotl Arena.
 *
 * ID layout:
 *   Common:    1-10   (10, existing)
 *   Uncommon:  11-176 (166, existing 11-50 + new 51-176)
 *   Rare:      177-226 (50, all new)
 *   Epic:      227-246 (20, all new)
 *   Legendary: 247-256 (10, relocated from existing 41-50)
 *
 * Steps:
 *   1. Output full card database JSON (names + ranks + descriptions)
 *   2. Generate DALL-E art for new cards
 *   3. Composite final card PNGs + board card PNGs
 *
 * Usage:
 *   node scripts/generate-256-cards.mjs                # Generate everything
 *   node scripts/generate-256-cards.mjs --data-only    # Just output the database, no art
 *   node scripts/generate-256-cards.mjs --art-only     # Just generate art from existing DB
 */

import OpenAI from 'openai';
import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';

// ── Config ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const API_KEY_PATH = '/Users/zac/aztec-triple-triad/OPEN_API_KEY.txt';
const CARDS_DIR = path.resolve(ROOT, 'packages/frontend/public/cards');
const FINAL_DIR = path.resolve(ROOT, 'packages/frontend/public/cards/final');
const BOARD_DIR = path.resolve(ROOT, 'packages/frontend/public/cards/board');
const CARD_FRONTS_DIR = path.resolve(ROOT, '../Swamp_Source_Files/CardFronts');
const DB_PATH = path.resolve(ROOT, 'scripts/card-database-256.json');

// ── Seeded RNG ──────────────────────────────────────────────────────────

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// ── Existing cards (IDs 1-50) ───────────────────────────────────────────

const EXISTING_CARDS = [
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

// ── Name lists for new cards ────────────────────────────────────────────

const UNCOMMON_NAMES = [
  'Puddle','Trickle','Dewdrop','Sprout','Nibbles','Pebble','Clover','Dapple',
  'Flicker','Rustle','Wisp','Bramble','Thistle','Burrow','Cricket','Minnow',
  'Pinecone','Acorn','Mushroom','Fiddlehead','Tadpole','Drizzle','Duskweed',
  'Cattail','Bulrush','Lichen','Toadskin','Barnacle','Kelp','Driftwood',
  'Ripple','Current','Eddy','Brook','Mossheart','Reedling','Fernback',
  'Cobble','Shingle','Dampfoot','Mudskipper','Puddlejump','Bogbean',
  'Waterlily','Pondweed','Duckweed','Silverfin','Quicksand','Rainfall',
  'Foghorn','Mistletoe','Juniper','Hazelnut','Walnut','Chestnut','Birchbark',
  'Pinewood','Willowbend','Elmshade','Ashleaf','Oakmoss','Cedarbloom',
  'Magnolia','Dahlia','Poppy','Marigold','Buttercup','Bluebell','Foxglove',
  'Harebell','Primrose','Snapdragon','Aster','Zinnia','Viola','Petunia',
  'Hyacinth','Crocus','Tulip','Iris','Orchid','Pansy','Jasmine','Lavender',
  'Rosemary','Thyme','Basil','Sage','Parsley','Fennel','Dill','Chive',
  'Oregano','Tarragon','Anise','Cardamom','Cinnamon','Ginger','Nutmeg',
  'Saffie','Tumeric','Cayenne','Paprika','Cumin','Coriander','Clove',
  'Allspice','Pimento','Sumac','Sesame','Starflower','Moonpetal','Sundew',
  'Nightbloom','Dawnbreeze','Duskbell','Twilight','Gloaming','Haze','Vapor',
  'Cloudburst','Sleet','Drizzletail','Steamvent','Fogcrawler','Mistwalker',
  'Dewclaw','Rainsong','Droplet','Sprinkle','Shower','Downpour','Torrent',
  'Freshet','Snowmelt','Icecap','Glacial','Frostbite','Wintergreen','Evergreen',
  'Pinestraw','Mapleleaf','Birchwood','Aspenleaf',
];

const RARE_NAMES = [
  'Abyssal','Tidecaller','Moonshadow','Stormwarden','Deeproot','Crystalvein',
  'Nightfall','Thornweaver','Emberclaw','Frostfang','Ironbark','Silverscale',
  'Goldmane','Bronzewing','Coppertail','Steelheart','Cobaltfin','Chromatic',
  'Prismatic','Opalescent','Pearlshine','Amethyst','Emeraldine','Rubythorn',
  'Topazglow','Garnetflare','Obsidian','Onyx','Turquoise','Malachite',
  'Lazuli','Aquamarine','Beryl','Zircon','Agate','Jasper','Carnelian',
  'Moonstone','Sunstone','Bloodstone','Thunderjaw','Stormscale','Windwalker',
  'Firebrand','Iceveil','Voidtouched','Netherbloom','Spiritfang','Soulreaver',
  'Doomhowl',
];

const EPIC_NAMES = [
  'Oblivion','Cataclysm','Apocalypse','Ragnarok','Armageddon',
  'Leviathan','Behemoth','Colossus','Juggernaut','Titan',
  'Seraphim','Nephilim','Archon','Sovereign','Imperator',
  'Nexus','Singularity','Infinity','Eternity','Genesis',
];

// ── Stat generation ─────────────────────────────────────────────────────

function generateStats(rng, rarity) {
  // Target stat sums by rarity
  const ranges = {
    uncommon: { min: 1, max: 6, targetSum: [12, 16] },
    rare:     { min: 2, max: 8, targetSum: [17, 22] },
    epic:     { min: 3, max: 9, targetSum: [22, 27] },
  };
  const r = ranges[rarity];
  const targetSum = randInt(rng, r.targetSum[0], r.targetSum[1]);

  // Generate 4 ranks that sum to targetSum
  let ranks = [0, 0, 0, 0];
  let remaining = targetSum;
  for (let i = 0; i < 3; i++) {
    const maxHere = Math.min(r.max, remaining - (3 - i) * r.min);
    const minHere = Math.max(r.min, remaining - (3 - i) * r.max);
    ranks[i] = randInt(rng, minHere, maxHere);
    remaining -= ranks[i];
  }
  ranks[3] = remaining;

  // Clamp
  for (let i = 0; i < 4; i++) {
    ranks[i] = Math.max(r.min, Math.min(r.max, ranks[i]));
  }

  // Shuffle
  for (let i = 3; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
  }

  return { top: ranks[0], right: ranks[1], bottom: ranks[2], left: ranks[3] };
}

// ── Description templates ───────────────────────────────────────────────

const UNCOMMON_DESCS = [
  'with subtle pattern variations and natural coloring',
  'with distinctive markings and a curious expression',
  'with mottled skin and alert eyes',
  'with a playful stance amid swamp flora',
  'blending naturally into its marshy environment',
  'with delicate gill fronds catching the light',
  'perched on a moss-covered log',
  'swimming through crystal-clear shallows',
];

const RARE_DESCS = [
  'with faint magical particles drifting from its gills',
  'with crystalline patterns across its skin that shimmer',
  'surrounded by a subtle aura of arcane energy',
  'with glowing eyes that pierce through swamp mist',
  'with iridescent scales that shift color in the light',
  'emanating a soft mystical glow from within',
];

const EPIC_DESCS = [
  'wreathed in dramatic magical energy and elemental power',
  'with intense arcane symbols etched into its skin',
  'surrounded by swirling vortex of elemental forces',
  'radiating overwhelming mystical presence and ancient power',
  'with crystalline armor and blazing magical aura',
];

function getDescription(name, rarity, rng) {
  const descs = rarity === 'uncommon' ? UNCOMMON_DESCS : rarity === 'rare' ? RARE_DESCS : EPIC_DESCS;
  const desc = descs[randInt(rng, 0, descs.length - 1)];
  return `A ${rarity} axolotl creature named ${name}, ${desc}. Painterly fantasy portrait style, swamp background, dramatic lighting.`;
}

// ── Build full 256-card database ────────────────────────────────────────

function buildDatabase() {
  const rng = mulberry32(42);
  const cards = [];

  // Common (1-10): existing, no changes
  for (const c of EXISTING_CARDS.filter(c => c.id <= 10)) {
    cards.push({ ...c, rarity: 'common' });
  }

  // Uncommon (11-176): existing 11-50 + new 51-176
  for (const c of EXISTING_CARDS.filter(c => c.id >= 11 && c.id <= 50)) {
    cards.push({ ...c, rarity: 'uncommon' });
  }
  let nameIdx = 0;
  for (let id = 51; id <= 176; id++) {
    const name = UNCOMMON_NAMES[nameIdx++];
    if (!name) throw new Error(`Ran out of uncommon names at id ${id}`);
    cards.push({
      id,
      name,
      ranks: generateStats(rng, 'uncommon'),
      rarity: 'uncommon',
      description: getDescription(name, 'uncommon', rng),
      needsArt: true,
    });
  }

  // Rare (177-226): all new
  nameIdx = 0;
  for (let id = 177; id <= 226; id++) {
    const name = RARE_NAMES[nameIdx++];
    if (!name) throw new Error(`Ran out of rare names at id ${id}`);
    cards.push({
      id,
      name,
      ranks: generateStats(rng, 'rare'),
      rarity: 'rare',
      description: getDescription(name, 'rare', rng),
      needsArt: true,
    });
  }

  // Epic (227-246): all new
  nameIdx = 0;
  for (let id = 227; id <= 246; id++) {
    const name = EPIC_NAMES[nameIdx++];
    if (!name) throw new Error(`Ran out of epic names at id ${id}`);
    cards.push({
      id,
      name,
      ranks: generateStats(rng, 'epic'),
      rarity: 'epic',
      description: getDescription(name, 'epic', rng),
      needsArt: true,
    });
  }

  // Legendary (247-256): relocated from existing 41-50
  const legendaries = EXISTING_CARDS.filter(c => c.id >= 41 && c.id <= 50);
  for (let i = 0; i < legendaries.length; i++) {
    const oldCard = legendaries[i];
    cards.push({
      id: 247 + i,
      name: oldCard.name,
      ranks: { ...oldCard.ranks },
      rarity: 'legendary',
      oldId: oldCard.id, // for art relocation
    });
  }

  return cards.sort((a, b) => a.id - b.id);
}

// ── DALL-E art generation ───────────────────────────────────────────────

async function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        writeFileSync(outputPath, Buffer.concat(chunks));
        resolve(outputPath);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateArt(card, openai) {
  const artPath = path.join(CARDS_DIR, `card-${card.id}.png`);
  if (existsSync(artPath)) {
    console.log(`  ~ Card ${card.id} (${card.name}) — art exists, skipping`);
    return;
  }

  const prompt = `Fantasy trading card illustration, painterly oil painting style with dramatic chiaroscuro lighting. ${card.description} Edge-to-edge painting with no border, no frame, no vignette. No text, no words, no letters, no numbers, no watermark, no UI elements.`;

  console.log(`  > Card ${card.id} (${card.name}) [${card.rarity}] — generating...`);
  const response = await openai.images.generate({
    model: 'dall-e-3', prompt, n: 1, size: '1024x1024', quality: 'standard',
  });
  await downloadImage(response.data[0].url, artPath);
  console.log(`  + Card ${card.id} (${card.name}) — saved`);
}

// ── Card compositing (same pipeline as generate-card-graphics.mjs) ──────

const CARD_W = 978, CARD_H = 1387;
const OVAL_X = 187, OVAL_Y = 136, OVAL_W = 596, OVAL_H = 804;
const OVAL_CX = OVAL_X + OVAL_W / 2, OVAL_CY = OVAL_Y + OVAL_H / 2;
const AXO_W = OVAL_W + 40, AXO_H = OVAL_H + 40;
const AXO_LEFT = Math.round(OVAL_CX - AXO_W / 2);
const AXO_TOP = Math.round(OVAL_CY - AXO_H / 2);
const ROUNDEL_R = 125;
const ROUNDEL_POS = {
  top: { x: 420, y: 8 }, right: { x: 801, y: 482 },
  bottom: { x: 420, y: 914 }, left: { x: 44, y: 482 },
};
const RC = {
  top: { x: ROUNDEL_POS.top.x + ROUNDEL_R, y: ROUNDEL_POS.top.y + ROUNDEL_R },
  right: { x: ROUNDEL_POS.right.x + ROUNDEL_R, y: ROUNDEL_POS.right.y + ROUNDEL_R },
  bottom: { x: ROUNDEL_POS.bottom.x + ROUNDEL_R, y: ROUNDEL_POS.bottom.y + ROUNDEL_R },
  left: { x: ROUNDEL_POS.left.x + ROUNDEL_R, y: ROUNDEL_POS.left.y + ROUNDEL_R },
};
const NAME_X = 149, NAME_Y = 1105, NAME_W = 686, NAME_H = 180;

function fmtRank(r) { return r === 10 ? 'A' : String(r); }
function escXml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }

function getTemplate(rarity) {
  const map = { common: 'card_common.png', uncommon: 'card_basic.png', rare: 'card_rare.png', epic: 'card_epic.png', legendary: 'card_legendary.png' };
  return map[rarity] || 'card_common.png';
}

function makeStatsSvg(ranks) {
  const fs = 220, sw = 16;
  const t = (v, cx, cy) => `<text x="${cx-62}" y="${cy-62}" font-family="Impact,'Arial Black',sans-serif" font-size="${fs}" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="white" stroke="black" stroke-width="${sw}" paint-order="stroke fill" filter="url(#ds)">${fmtRank(v)}</text>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.9"/></filter></defs>${t(ranks.top,RC.top.x,RC.top.y)}${t(ranks.right,RC.right.x,RC.right.y)}${t(ranks.bottom,RC.bottom.x,RC.bottom.y)}${t(ranks.left,RC.left.x,RC.left.y)}</svg>`);
}

function makeNameSvg(name) {
  let fs = 112;
  if (name.length > 10) fs = 96;
  if (name.length > 13) fs = 80;
  if (name.length > 17) fs = 64;
  const cx = NAME_X + NAME_W / 2, cy = NAME_Y + NAME_H / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><defs><filter id="ds" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.7"/></filter></defs><text x="${cx}" y="${cy}" font-family="Impact,'Arial Black',sans-serif" font-size="${fs}" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="white" stroke="black" stroke-width="8" paint-order="stroke fill" filter="url(#ds)">${escXml(name)}</text></svg>`);
}

async function compositeFinalCard(card) {
  const artFile = path.join(CARDS_DIR, `card-${card.id}.png`);
  const outputFile = path.join(FINAL_DIR, `card-${card.id}.png`);
  const templateFile = path.join(CARD_FRONTS_DIR, getTemplate(card.rarity));
  if (!existsSync(artFile) || !existsSync(templateFile)) return null;

  const art = await sharp(artFile).resize(AXO_W, AXO_H, { fit: 'cover' }).toBuffer();
  const tmpl = await sharp(templateFile).resize(CARD_W, CARD_H, { fit: 'fill' }).toBuffer();
  const result = await sharp({ create: { width: CARD_W, height: CARD_H, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } })
    .composite([
      { input: art, left: AXO_LEFT, top: AXO_TOP },
      { input: tmpl, left: 0, top: 0 },
      { input: makeStatsSvg(card.ranks), left: 0, top: 0 },
      { input: makeNameSvg(card.name), left: 0, top: 0 },
    ]).png().toBuffer();
  await sharp(result).toFile(outputFile);
  return outputFile;
}

// Board card compositing
const BOARD_SIZE = 1052;
const B_OVAL_X=221, B_OVAL_Y=121, B_OVAL_W=611, B_OVAL_H=803;
const B_CX=B_OVAL_X+B_OVAL_W/2, B_CY=B_OVAL_Y+B_OVAL_H/2;
const B_AXO_W=B_OVAL_W+20, B_AXO_H=B_OVAL_H+20;
const B_AXO_LEFT=Math.round(B_CX-B_AXO_W/2), B_AXO_TOP=Math.round(B_CY-B_AXO_H/2);
const B_RSIZE=125;
const B_RP={top:{x:462,y:7},right:{x:828,y:416},bottom:{x:462,y:906},left:{x:99,y:416}};
const B_RC={
  top:{x:B_RP.top.x+B_RSIZE/2,y:B_RP.top.y+B_RSIZE/2},
  right:{x:B_RP.right.x+B_RSIZE/2,y:B_RP.right.y+B_RSIZE/2},
  bottom:{x:B_RP.bottom.x+B_RSIZE/2,y:B_RP.bottom.y+B_RSIZE/2},
  left:{x:B_RP.left.x+B_RSIZE/2,y:B_RP.left.y+B_RSIZE/2},
};

function makeBoardStatsSvg(ranks) {
  const fs=140, sw=5;
  const t=(v,cx,cy)=>`<text x="${cx}" y="${cy}" font-family="Impact,'Arial Black',sans-serif" font-size="${fs}" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="white" stroke="black" stroke-width="${sw}" paint-order="stroke fill" filter="url(#ds)">${fmtRank(v)}</text>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_SIZE}" height="${BOARD_SIZE}"><defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.9"/></filter></defs>${t(ranks.top,B_RC.top.x,B_RC.top.y)}${t(ranks.right,B_RC.right.x,B_RC.right.y)}${t(ranks.bottom,B_RC.bottom.x,B_RC.bottom.y)}${t(ranks.left,B_RC.left.x,B_RC.left.y)}</svg>`);
}

async function compositeBoardCard(card, frameBuffer) {
  const artFile = path.join(CARDS_DIR, `card-${card.id}.png`);
  const outputFile = path.join(BOARD_DIR, `card-${card.id}-board.png`);
  if (!existsSync(artFile)) return null;

  const art = await sharp(artFile).resize(B_AXO_W, B_AXO_H, { fit: 'cover' }).toBuffer();
  const erx = Math.round(B_AXO_W/2), ery = Math.round(erx * 1.314);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${B_AXO_W}" height="${B_AXO_H}"><ellipse cx="${B_AXO_W/2}" cy="${B_AXO_H/2}" rx="${erx}" ry="${ery}" fill="white"/></svg>`);
  const clipped = await sharp(art).composite([{ input: mask, blend: 'dest-in' }]).toBuffer();

  const result = await sharp({ create: { width: BOARD_SIZE, height: BOARD_SIZE, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } })
    .composite([
      { input: clipped, left: B_AXO_LEFT, top: B_AXO_TOP },
      { input: frameBuffer, left: 0, top: 0 },
      { input: makeBoardStatsSvg(card.ranks), left: 0, top: 0 },
    ]).png().toBuffer();
  await sharp(result).toFile(outputFile);
  return outputFile;
}

// ── Output helpers ──────────────────────────────────────────────────────

function outputCardDatabaseTS(cards) {
  const lines = cards.map(c =>
    `  { id: ${c.id}, name: '${c.name.replace(/'/g, "\\'")}', ranks: { top: ${c.ranks.top}, right: ${c.ranks.right}, bottom: ${c.ranks.bottom}, left: ${c.ranks.left} } },`
  );
  return `import type { Card } from './types';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/**
 * Get the rarity tier for a card by ID.
 * Common: 1-10, Uncommon: 11-176, Rare: 177-226, Epic: 227-246, Legendary: 247-256
 */
export function getCardRarity(cardId: number): Rarity {
  if (cardId >= 247) return 'legendary';
  if (cardId >= 227) return 'epic';
  if (cardId >= 177) return 'rare';
  if (cardId >= 11) return 'uncommon';
  return 'common';
}

export const CARD_DATABASE: Card[] = [
${lines.join('\n')}
];

export function getCardById(id: number): Card | undefined {
  return CARD_DATABASE.find(c => c.id === id);
}

export function getRandomHand(count = 5): Card[] {
  const shuffled = [...CARD_DATABASE].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(c => ({ ...c }));
}

export function getRandomHandIds(availableIds: number[], count = 5): number[] {
  if (availableIds.length <= count) return [...availableIds];
  const shuffled = [...availableIds].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export function formatRank(rank: number): string {
  return rank === 10 ? 'A' : String(rank);
}
`;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dataOnly = args.includes('--data-only');
  const artOnly = args.includes('--art-only');

  console.log('=== 256-Card Database Generator ===\n');

  // Build or load database
  let cards;
  if (artOnly && existsSync(DB_PATH)) {
    cards = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    console.log(`Loaded ${cards.length} cards from ${DB_PATH}`);
  } else {
    cards = buildDatabase();
    writeFileSync(DB_PATH, JSON.stringify(cards, null, 2));
    console.log(`Generated ${cards.length} cards, saved to ${DB_PATH}`);
  }

  // Output TypeScript database
  const tsOutput = outputCardDatabaseTS(cards);
  const tsPath = path.resolve(ROOT, 'packages/frontend/src/cards.ts');
  writeFileSync(tsPath, tsOutput);
  console.log(`Written ${tsPath}`);

  if (dataOnly) {
    console.log('\n--data-only: skipping art generation');
    return;
  }

  // Ensure directories
  for (const d of [CARDS_DIR, FINAL_DIR, BOARD_DIR]) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }

  // Relocate legendary art (copy from old IDs 41-50 to new IDs 247-256)
  console.log('\nRelocating legendary card art...');
  for (const card of cards.filter(c => c.oldId)) {
    const src = path.join(CARDS_DIR, `card-${card.oldId}.png`);
    const dst = path.join(CARDS_DIR, `card-${card.id}.png`);
    if (existsSync(src) && !existsSync(dst)) {
      copyFileSync(src, dst);
      console.log(`  Copied card-${card.oldId}.png -> card-${card.id}.png`);
    }
  }

  // Generate DALL-E art for new cards
  const newCards = cards.filter(c => c.needsArt);
  console.log(`\nGenerating DALL-E art for ${newCards.length} new cards...\n`);

  const apiKey = readFileSync(API_KEY_PATH, 'utf-8').trim();
  const openai = new OpenAI({ apiKey });

  let artSuccess = 0, artFailed = 0;
  for (const card of newCards) {
    try {
      await generateArt(card, openai);
      artSuccess++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  x Card ${card.id} (${card.name}): ${err.message}`);
      artFailed++;
    }
  }
  console.log(`\nArt: ${artSuccess} generated, ${artFailed} failed\n`);

  // Composite final cards
  console.log('Compositing final card PNGs...');
  let compSuccess = 0;
  for (const card of cards) {
    try {
      if (await compositeFinalCard(card)) compSuccess++;
    } catch (err) {
      console.error(`  x Card ${card.id}: ${err.message}`);
    }
  }
  console.log(`Final cards: ${compSuccess} composited`);

  // Composite board cards
  console.log('\nCompositing board card PNGs...');
  const framePath = path.join(CARD_FRONTS_DIR, 'card_on_board.png');
  const frameBuffer = await sharp(framePath)
    .resize(BOARD_SIZE, BOARD_SIZE, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } })
    .toBuffer();

  let boardSuccess = 0;
  for (const card of cards) {
    try {
      if (await compositeBoardCard(card, frameBuffer)) boardSuccess++;
    } catch (err) {
      console.error(`  x Card ${card.id}: ${err.message}`);
    }
  }
  console.log(`Board cards: ${boardSuccess} composited`);

  console.log('\nDone!');
}

main().catch(console.error);
