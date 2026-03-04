#!/usr/bin/env node
/**
 * UI Element Asset Generator
 *
 * Generates pixel art UI assets using DALL-E 3:
 * - card-pack.png: Card pack image for pack opening animation
 * - button.png: Fantasy-style button background
 * - button-hover.png: Hover state button
 * - axolotl-search.png: Pixel art axolotl hunting bug (for opponent search)
 * - hunt-river.png: Pixel art axolotl in river biome
 * - hunt-forest.png: Pixel art axolotl in forest biome
 * - hunt-beach.png: Pixel art axolotl in beach biome
 * - hunt-city.png: Pixel art axolotl in city biome
 * - hunt-dockyard.png: Pixel art axolotl in dockyard biome
 *
 * Usage:
 *   node scripts/generate-ui-elements.mjs              # generate all missing
 *   node scripts/generate-ui-elements.mjs --force      # regenerate all
 *   node scripts/generate-ui-elements.mjs card-pack    # generate specific asset
 */

import OpenAI from 'openai';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

// ── Config ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const API_KEY_PATH = path.join(ROOT, 'OPEN_API_KEY.txt');
const OUTPUT_DIR = path.resolve(ROOT, 'packages/frontend/public/ui-elements');

let apiKeyFile = API_KEY_PATH;
if (!existsSync(apiKeyFile)) {
  apiKeyFile = '/Users/zac/OPEN_API_KEY.txt';
}
const apiKey = readFileSync(apiKeyFile, 'utf-8').trim();
const openai = new OpenAI({ apiKey });

// ── Asset Definitions ────────────────────────────────────────────────────

const PIXEL_ART_STYLE = `16-bit pixel art style, clean crisp pixels visible, retro SNES/GBA game aesthetic, limited color palette, dark background (#0a120a), no anti-aliasing, sharp pixel edges, game sprite style. The scene should be a small animated-looking vignette.`;

const ASSETS = {
  'card-pack': {
    prompt: `A mystical card pack for a trading card game, dark green and gold color scheme. The pack is wrapped in ornate paper with glowing runes and an axolotl emblem embossed in gold. Swamp vines curl around the edges. Dark moody lighting with gold rim highlights. Digital painting, centered on dark background (#0a120a). NO text, NO words, NO letters.`,
    size: '1024x1024',
  },
  'button': {
    prompt: `A wide horizontal fantasy UI button for a dark-themed card game. Ornate stone/wood frame with carved vine patterns and subtle gold trim. Dark green interior (#1a2e1a) with a slight inner glow. The button is empty (no text). Swamp/nature themed decorative border. Game UI element, centered on transparent-looking dark background. Flat front-facing view, no perspective. NO text, NO words.`,
    size: '1792x1024',
  },
  'button-hover': {
    prompt: `A wide horizontal fantasy UI button for a dark-themed card game in a HIGHLIGHTED/ACTIVE state. Ornate stone/wood frame with carved vine patterns and bright gold trim GLOWING. Dark green interior with a warm golden inner glow emanating outward. The button is empty (no text). Swamp/nature themed decorative border with luminous accents. Game UI element, centered on transparent-looking dark background. Flat front-facing view, no perspective. NO text, NO words.`,
    size: '1792x1024',
  },
  'axolotl-search': {
    prompt: `${PIXEL_ART_STYLE} A cute pink-green axolotl character with external gills, crawling across a dark swamp scene, chasing a small glowing golden firefly/bug. The axolotl has a determined hunting expression. Small lily pads and reeds in the background. Moonlight illuminates the scene. The composition shows the axolotl mid-stride from left to right with the bug flying ahead. Wide panoramic format showing the chase. NO text.`,
    size: '1792x1024',
  },
  'hunt-river': {
    prompt: `${PIXEL_ART_STYLE} A cute pink axolotl swimming in a shallow crystal-clear river, hunting for tiny glowing insects hovering above the water surface. Smooth river stones on the bottom, small fish swimming, water ripples catching moonlight. Reeds and cattails on the riverbank. Serene nighttime river scene with fireflies. Wide panoramic format. NO text.`,
    size: '1792x1024',
  },
  'hunt-forest': {
    prompt: `${PIXEL_ART_STYLE} A cute green axolotl creeping through a dense dark forest floor, hunting glowing beetles among fallen leaves and mushrooms. Massive tree trunks tower above, bioluminescent fungi glow on bark, fireflies drift between ferns. Dappled moonlight filters through the canopy. Mysterious forest atmosphere. Wide panoramic format. NO text.`,
    size: '1792x1024',
  },
  'hunt-beach': {
    prompt: `${PIXEL_ART_STYLE} A cute blue axolotl exploring tidal pools on a moonlit beach, hunting small glowing crabs and sea insects. Waves lap at the shore, seashells scattered on sand, a lighthouse glows in the distance. Starry sky reflected in the tidal pools. Coastal nighttime atmosphere. Wide panoramic format. NO text.`,
    size: '1792x1024',
  },
  'hunt-city': {
    prompt: `${PIXEL_ART_STYLE} A cute purple axolotl navigating through urban storm drains and puddles at night, hunting glowing moths near a streetlight. Cobblestone streets, rain puddles reflecting neon signs, steam rising from grates. Cyberpunk-meets-medieval city atmosphere. Wide panoramic format. NO text.`,
    size: '1792x1024',
  },
  'hunt-dockyard': {
    prompt: `${PIXEL_ART_STYLE} A cute golden/legendary axolotl diving into deep dark harbor water near wooden dock pilings, hunting a rare glowing deep-sea insect. Barnacle-covered pilings, ship hulls visible above, lanterns hanging from docks cast warm light into murky water. Mysterious deep-water atmosphere. Wide panoramic format. NO text.`,
    size: '1792x1024',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateAsset(name, config) {
  const outPath = path.join(OUTPUT_DIR, `${name}.png`);

  console.log(`  Generating ${name}...`);
  console.log(`    Prompt: ${config.prompt.slice(0, 100)}...`);

  try {
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: config.prompt,
      n: 1,
      size: config.size,
      quality: 'hd',
    });

    const imageUrl = response.data[0].url;
    console.log(`    Downloading...`);

    const imageData = await downloadImage(imageUrl);
    writeFileSync(outPath, imageData);
    console.log(`    Saved: ${outPath} (${(imageData.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (err) {
    console.error(`    FAILED: ${err.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const specificAssets = args.filter((a) => !a.startsWith('--'));

  const assetNames = specificAssets.length > 0
    ? specificAssets.filter((n) => ASSETS[n])
    : Object.keys(ASSETS);

  if (specificAssets.length > 0) {
    const unknown = specificAssets.filter((n) => !ASSETS[n]);
    if (unknown.length) {
      console.warn(`Unknown assets: ${unknown.join(', ')}`);
      console.log(`Available: ${Object.keys(ASSETS).join(', ')}`);
    }
  }

  console.log(`\nGenerating ${assetNames.length} UI assets...\n`);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of assetNames) {
    const outPath = path.join(OUTPUT_DIR, `${name}.png`);
    if (!force && existsSync(outPath)) {
      console.log(`  Skipping ${name} (already exists, use --force to regenerate)`);
      skipped++;
      continue;
    }

    const success = await generateAsset(name, ASSETS[name]);
    if (success) generated++;
    else failed++;

    // Rate limiting: wait 1s between requests
    if (assetNames.indexOf(name) < assetNames.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`\nDone! Generated: ${generated}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
