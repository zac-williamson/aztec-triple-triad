#!/usr/bin/env node
/**
 * Generate DALL-E scene images with "-dalle" suffix.
 * Does NOT overwrite existing ui-elements assets.
 */

import OpenAI from 'openai';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const apiKey = readFileSync(path.join(ROOT, 'OPEN_API_KEY.txt'), 'utf-8').trim();
const openai = new OpenAI({ apiKey });

const OUT = path.join(ROOT, 'packages/frontend/public/ui-elements/dalle');
mkdirSync(OUT, { recursive: true });

const PIXEL_ART_STYLE = `16-bit pixel art style, clean crisp pixels visible, retro SNES/GBA game aesthetic, limited color palette, dark background (#0a120a), no anti-aliasing, sharp pixel edges, game sprite style. The scene should be a small animated-looking vignette.`;

const SCENES = {
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

async function main() {
  const names = Object.keys(SCENES);
  console.log(`Generating ${names.length} DALL-E scenes into ${OUT}\n`);

  for (const name of names) {
    const config = SCENES[name];
    const outPath = path.join(OUT, `${name}.png`);
    console.log(`  ${name}.png ...`);

    try {
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: config.prompt,
        n: 1,
        size: config.size,
        quality: 'hd',
      });

      const imageData = await downloadImage(response.data[0].url);
      writeFileSync(outPath, imageData);
      console.log(`    -> ${(imageData.length / 1024).toFixed(0)} KB`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
    }

    // Rate limit pause
    if (names.indexOf(name) < names.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log('\nDone! Files saved to:', OUT);
}

main().catch((err) => { console.error(err); process.exit(1); });
