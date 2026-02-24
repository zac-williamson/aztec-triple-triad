/**
 * Card art generation script using OpenAI DALL-E API.
 * Generates unique card art for all 50 cards in the database.
 *
 * Usage: npx tsx scripts/generate-card-art.ts [--start=N] [--count=N]
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const API_KEY = fs.readFileSync(path.join(__dirname, '..', 'OPEN_API_KEY.txt'), 'utf-8').trim();
const OUTPUT_DIR = path.join(__dirname, '..', 'packages', 'frontend', 'public', 'cards');

interface CardInfo {
  id: number;
  name: string;
  level: number;
  description: string;
}

const CARDS: CardInfo[] = [
  // Level 1 — Common
  { id: 1, name: 'Mudwalker', level: 1, description: 'a wild-type axolotl, mottled brown-green with gold speckles, dark eyes with gold ring' },
  { id: 2, name: 'Blushy', level: 1, description: 'a leucistic axolotl, pale pink-white body, bright red feathery gills, black eyes' },
  { id: 3, name: 'Snowdrop', level: 1, description: 'a white albino axolotl, pure white translucent body, pinkish-red eyes, pale pink gills' },
  { id: 4, name: 'Sunny', level: 1, description: 'a golden albino axolotl, warm golden-yellow body with shimmering iridescent speckles, pink eyes' },
  { id: 5, name: 'Inkwell', level: 1, description: 'a melanoid axolotl, uniform jet-black body, completely matte dark, no iridescence' },
  { id: 6, name: 'Stripes', level: 1, description: 'a tiger salamander, brown-black body with bold irregular olive-yellow blotches and bars' },
  { id: 7, name: 'Barkeeper', level: 1, description: 'a barred tiger salamander, dark body with large yellowish bars and defined blotches' },
  { id: 8, name: 'Dotty', level: 1, description: 'a spotted salamander, jet-black body with two rows of bright yellow round spots' },
  { id: 9, name: 'Penny', level: 1, description: 'a copper axolotl, warm tannish-copper body with reddish-brown freckles, dark eyes' },
  { id: 10, name: 'Peaches', level: 1, description: 'a light copper axolotl, pale pinkish-tan body with faint copper freckling' },

  // Level 2 — Uncommon
  { id: 11, name: 'Freckles', level: 2, description: 'a dirty leucistic axolotl, white-pink base with scattered dark brown speckles on head' },
  { id: 12, name: 'Camo', level: 2, description: 'a heavily marked melanoid axolotl, dark base with light green-yellow splotches, camouflage pattern' },
  { id: 13, name: 'Neon', level: 2, description: 'a GFP wild-type axolotl, brown-green under daylight, glows vivid green under UV' },
  { id: 14, name: 'Glow Bug', level: 2, description: 'a GFP leucistic axolotl, pink-white body that fluoresces brilliant green under UV' },
  { id: 15, name: 'Limelight', level: 2, description: 'a GFP golden albino axolotl, golden-yellow body that glows intense green under blacklight' },
  { id: 16, name: 'Marble', level: 2, description: 'a marbled salamander, black body with bold silvery-white crossbands, painted look' },
  { id: 17, name: 'Sapphire', level: 2, description: 'a blue-spotted salamander, dark black-blue body with bright blue-white flecks' },
  { id: 18, name: 'Jefferson', level: 2, description: 'a Jefferson salamander, long slender dark brown body with scattered pale blue flecks' },
  { id: 19, name: 'Longfoot', level: 2, description: 'a long-toed salamander, dark black body with bold yellowish-green dorsal stripe' },
  { id: 20, name: 'Featherfin', level: 2, description: 'a ridiculously long-gilled axolotl, dramatically elongated flowing gill filaments' },

  // Level 3 — Rare
  { id: 21, name: 'Lilac', level: 3, description: 'a lavender silver dalmatian axolotl, soft silvery-purple body with dark spots' },
  { id: 22, name: 'Patches', level: 3, description: 'a piebald axolotl, white base with bold irregular dark green-black patches, red gills' },
  { id: 23, name: 'Faded', level: 3, description: 'a hypomelanistic axolotl, washed-out pale grayish-beige, ghostly and subtle' },
  { id: 24, name: 'Gold Dust', level: 3, description: 'a hypomelanistic copper axolotl, golden albino look but with dark eyes, shimmery golden body' },
  { id: 25, name: 'Phantom', level: 3, description: 'a hypomelanistic melanoid axolotl, pale gray with beige undertone, darker gills, muted' },
  { id: 26, name: 'Ash', level: 3, description: 'an axanthic axolotl, cool-toned gray-blue-black body, no warm coloring, silvery steel' },
  { id: 27, name: 'Cocoa', level: 3, description: 'a melanoid copper axolotl, dark chocolate-brown, warm reddish-brown tones throughout' },
  { id: 28, name: 'Ringmaster', level: 3, description: 'a ringed salamander, dark brown-black body with narrow pale yellow rings at intervals' },
  { id: 29, name: 'Goldrush', level: 3, description: 'a California tiger salamander, black body with creamy-white spots and bars' },
  { id: 30, name: 'Swampling', level: 3, description: 'a flatwoods salamander, slender dark gray-black with fine silver reticulated pattern' },

  // Level 4 — Epic
  { id: 31, name: 'Glitter', level: 4, description: 'a high-iridophore golden albino axolotl, entire body densely covered in shimmering reflective speckles' },
  { id: 32, name: 'Starfield', level: 4, description: 'a high-iridophore wild type axolotl, dark olive body spangled with golden-white sparkles' },
  { id: 33, name: 'Specter', level: 4, description: 'a GFP dirty lucy axolotl, white body with dark freckles that glows green under UV' },
  { id: 34, name: 'Saffron', level: 4, description: 'a non-albino golden axolotl, vibrant golden-yellow body with dark eyes, rich saturated gold' },
  { id: 35, name: 'Stardust', level: 4, description: 'a piebald GFP axolotl, white body with dark patches, white areas fluoresce green, cosmic pattern' },
  { id: 36, name: 'Achoque', level: 4, description: 'a Lake Patzcuaro salamander (A. dumerilii), dark olive-brown, large bushy red gills' },
  { id: 37, name: 'Zacapu', level: 4, description: 'an Anderson salamander (A. andersoni), red-brown with black blotches, bright red gills' },
  { id: 38, name: 'Laguna', level: 4, description: 'a Taylor salamander (A. taylori), pale grayish body, adapted to alkaline water' },
  { id: 39, name: 'Streamwalker', level: 4, description: 'a Michoacan stream siredon, slender dark brown with lighter mottling' },
  { id: 40, name: 'Digger', level: 4, description: 'a mole salamander, stocky with oversized head, dark brown-gray, chunky burrower' },

  // Level 5 — Legendary
  { id: 41, name: 'Eclipse', level: 5, description: 'a MAC (melanoid axanthic copper) axolotl, triple recessive, velvety dark purplish-brown' },
  { id: 42, name: 'Kaleidoscope', level: 5, description: 'a mosaic axolotl, random patchwork of black, white, and golden flecks, every one unique' },
  { id: 43, name: 'Twinned', level: 5, description: 'a chimera axolotl, body split down the middle: one half dark, other half light' },
  { id: 44, name: 'Sparkletail', level: 5, description: 'a firefly axolotl, dark body with leucistic GFP tail that glows green under blacklight' },
  { id: 45, name: 'Riddler', level: 5, description: 'an enigma axolotl, born black then develops patches of gray, white, and iridescent gold' },
  { id: 46, name: 'Rosita', level: 5, description: 'a Tarahumara salamander (A. rosaceum), pinkish-brown rosy-tan body with dark reticulations' },
  { id: 47, name: 'Brooklet', level: 5, description: 'a streamside salamander, small dark brown body with gray lichen-like mottling' },
  { id: 48, name: 'Whisper', level: 5, description: 'a small-mouthed salamander, dark brown-black with fine silver lichen-like markings' },
  { id: 49, name: 'Misty', level: 5, description: 'a Mabee salamander, brown body with scattered light gray flecking, slender build' },
  { id: 50, name: 'Lerma', level: 5, description: 'a Lake Lerma salamander (A. lermaense), dark brown-black, robust build, critically endangered' },
];

function getStyleForLevel(level: number): string {
  switch (level) {
    case 1: return 'simple clean composition, soft pastel background';
    case 2: return 'slightly more detailed, subtle background pattern';
    case 3: return 'detailed with subtle sparkle effects, gentle glow';
    case 4: return 'highly detailed with golden shimmer effects, rich colors';
    case 5: return 'maximum detail with ethereal glow, prismatic light effects, legendary aura';
    default: return '';
  }
}

function buildPrompt(card: CardInfo): string {
  return `Cute illustration of ${card.description}. Hand-drawn style with thick black outlines, moderate contrast, slight pop-art aesthetic. The creature is centered, facing the viewer, with an endearing expression. Clean white background. ${getStyleForLevel(card.level)}. The style should feel like a collectible sticker or trading card character. Square format, no text, no borders.`;
}

async function generateImage(card: CardInfo): Promise<Buffer> {
  const prompt = buildPrompt(card);
  console.log(`  Generating: ${card.name} (Level ${card.level})`);

  const body = JSON.stringify({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    quality: 'standard',
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/images/generations',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(`API error: ${json.error.message}`));
              return;
            }
            const url = json.data?.[0]?.url;
            if (!url) {
              reject(new Error('No image URL in response'));
              return;
            }
            // Download the image
            downloadImage(url).then(resolve).catch(reject);
          } catch (e) {
            reject(new Error(`Parse error: ${e}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadImage(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  let startIdx = 0;
  let count = CARDS.length;

  for (const arg of args) {
    if (arg.startsWith('--start=')) startIdx = parseInt(arg.split('=')[1]) - 1;
    if (arg.startsWith('--count=')) count = parseInt(arg.split('=')[1]);
  }

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const cardsToGenerate = CARDS.slice(startIdx, startIdx + count);
  console.log(`Generating art for ${cardsToGenerate.length} cards...`);
  console.log(`Output directory: ${OUTPUT_DIR}\n`);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const card of cardsToGenerate) {
    const outputPath = path.join(OUTPUT_DIR, `card-${card.id}.png`);

    // Skip if already exists
    if (fs.existsSync(outputPath)) {
      console.log(`  Skipping ${card.name} (already exists)`);
      skipped++;
      continue;
    }

    try {
      const imageBuffer = await generateImage(card);
      fs.writeFileSync(outputPath, imageBuffer);
      console.log(`  Saved: card-${card.id}.png`);
      generated++;

      // Rate limit: DALL-E 3 allows ~5 images/min
      if (generated % 5 === 0) {
        console.log('  Rate limit pause (60s)...');
        await sleep(60000);
      } else {
        await sleep(12000); // ~12s between requests
      }
    } catch (err: any) {
      console.error(`  FAILED ${card.name}: ${err.message}`);
      failed++;
      // Wait longer after errors
      await sleep(30000);
    }
  }

  console.log(`\nDone! Generated: ${generated}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch(console.error);
