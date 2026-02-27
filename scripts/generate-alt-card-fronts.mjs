#!/usr/bin/env node
/**
 * Generate alternative card front templates via DALL-E 3.
 *
 * Each template looks like the existing card_basic/common/rare/epic/legendary
 * frames but with a slightly smaller oval and 4 blue roundel badges positioned
 * just outside the oval at top, bottom, left, and right.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = fs.readFileSync('/Users/zac/aztec-triple-triad/OPEN_API_KEY.txt', 'utf-8').trim();
const OUTPUT_DIR = '/Users/zac/aztec-triple-triad-ui/Swamp_Source_Files/CardFronts';

// ── Prompt template — $COLOR is replaced per rarity ──

const PROMPT_TEMPLATE = `A highly detailed fantasy collectible card frame in an ancient Aztec-inspired style. The card is a strict vertical rectangle with transparent background outside the frame. The frame is made of weathered stone and ornate gold trim, decorated with subtle moss and vines. In the center is a slightly reduced-size transparent oval cutout (true transparency). Surrounding the oval are four large glowing blue round gemstones (roundels) positioned at the top, bottom, left, and right of the oval. The gemstones are about 20% larger than normal and slightly overlap/intersect the golden oval border. There is a $COLOR diamond-shaped gem in the top-left corner of the card. The design should feel symmetrical, clean, and game-ready, with high resolution, sharp edges, and clear separation between stone, gold, and gemstone materials. The lower portion contains a blank stone nameplate area. Lighting is soft fantasy ambient lighting with subtle glow on the blue gemstones. The final image must be a clean PNG asset suitable for a card game UI.`;

// ── Per-rarity variants ──

const VARIANTS = [
  { name: 'card_common_alt',    color: 'green' },
  { name: 'card_rare_alt',      color: 'blue' },
  { name: 'card_epic_alt',      color: 'purple' },
  { name: 'card_legendary_alt', color: 'gold' },
];

// ── Generation ──

async function generateImage(variant) {
  const outputPath = path.join(OUTPUT_DIR, `${variant.name}.png`);

  if (fs.existsSync(outputPath) && !process.argv.includes('--force')) {
    console.log(`  ⊘ ${variant.name} already exists, skipping (use --force to overwrite)`);
    return;
  }

  const prompt = PROMPT_TEMPLATE.replace('$COLOR', variant.color);
  console.log(`  ⏳ Generating ${variant.name} (${variant.color} gem)...`);

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'hd',
      style: 'vivid',
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`  ✗ ${variant.name} FAILED: ${response.status} ${text.slice(0, 200)}`);
    return;
  }

  const data = await response.json();
  const b64 = data.data[0].b64_json;
  const buffer = Buffer.from(b64, 'base64');
  fs.writeFileSync(outputPath, buffer);
  console.log(`  ✓ ${variant.name} -> ${outputPath}`);
}

async function main() {
  console.log('Alternative Card Front Generator');
  console.log('================================\n');
  console.log(`Output: ${OUTPUT_DIR}\n`);

  for (const variant of VARIANTS) {
    await generateImage(variant);
    // Rate limit: ~15s between requests
    if (variant !== VARIANTS[VARIANTS.length - 1]) {
      console.log('    (waiting 15s for rate limit...)');
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
