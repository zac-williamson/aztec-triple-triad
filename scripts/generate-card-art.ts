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
  // Level 1 - Common creatures
  { id: 1, name: 'Geezard', level: 1, description: 'a small scaly lizard creature with sharp claws' },
  { id: 2, name: 'Funguar', level: 1, description: 'a walking mushroom monster with glowing spores' },
  { id: 3, name: 'Bite Bug', level: 1, description: 'a large insect with oversized mandibles and translucent wings' },
  { id: 4, name: 'Red Bat', level: 1, description: 'a crimson bat with glowing red eyes and razor-sharp fangs' },
  { id: 5, name: 'Blobra', level: 1, description: 'an amorphous blob creature with a single eye' },
  { id: 6, name: 'Gayla', level: 1, description: 'a floating manta ray creature with ethereal wings' },
  { id: 7, name: 'Gesper', level: 1, description: 'a mysterious floating mask spirit with arcane runes' },
  { id: 8, name: 'Fastitocalon-F', level: 1, description: 'a small fish-like creature with armored scales' },
  { id: 9, name: 'Blood Soul', level: 1, description: 'a ghostly apparition dripping with dark energy' },
  { id: 10, name: 'Caterchipillar', level: 1, description: 'a giant caterpillar with segments of different colors' },

  // Level 2 - Uncommon creatures
  { id: 11, name: 'Cockatrice', level: 2, description: 'a rooster-dragon hybrid with stone-turning gaze and scaled wings' },
  { id: 12, name: 'Grat', level: 2, description: 'a carnivorous plant monster with thrashing vine tentacles' },
  { id: 13, name: 'Buel', level: 2, description: 'a winged demon head with bat-like wings and horns' },
  { id: 14, name: 'Mesmerize', level: 2, description: 'an elegant deer-like creature with a spiraling crystal horn' },
  { id: 15, name: 'Glacial Eye', level: 2, description: 'a floating eye encased in a sphere of ice crystals' },
  { id: 16, name: 'Belhelmel', level: 2, description: 'a bell-shaped monster with multiple swinging tentacles' },
  { id: 17, name: 'Thrustaevis', level: 2, description: 'a swift predatory bird with metallic feathers and blade-like wings' },
  { id: 18, name: 'Anacondaur', level: 2, description: 'a massive serpent with dinosaur-like features and armored scales' },
  { id: 19, name: 'Creeps', level: 2, description: 'a dark crawling shadow creature with multiple glowing eyes' },
  { id: 20, name: 'Grendel', level: 2, description: 'a powerful dragon-like beast with thick green scales' },

  // Level 3 - Rare creatures
  { id: 21, name: 'Jelleye', level: 3, description: 'a giant jellyfish with a central glowing eye and electric tentacles' },
  { id: 22, name: 'Grand Mantis', level: 3, description: 'an enormous praying mantis with crystalline blade arms' },
  { id: 23, name: 'Forbidden', level: 3, description: 'a forbidden ancient book that floats surrounded by dark magic runes' },
  { id: 24, name: 'Armadodo', level: 3, description: 'a heavily armored quadruped with stone plates and earth magic' },
  { id: 25, name: 'Tri-Face', level: 3, description: 'a three-headed beast each face showing different emotions' },
  { id: 26, name: 'Fastitocalon', level: 3, description: 'a massive whale-fish creature with ancient runes on its body' },
  { id: 27, name: 'Snow Lion', level: 3, description: 'a majestic lion made of living snow and ice crystals' },
  { id: 28, name: 'Ochu', level: 3, description: 'a towering plant monster with massive thorned vines and a gaping maw' },
  { id: 29, name: 'SAM08G', level: 3, description: 'a military robot with spinning saw blades and red targeting lasers' },
  { id: 30, name: 'Death Claw', level: 3, description: 'a menacing beast with massive razor claws dripping with venom' },

  // Level 4 - Epic creatures
  { id: 31, name: 'Tonberry', level: 4, description: 'a small robed green creature holding a lantern and a chefs knife' },
  { id: 32, name: 'Abyss Worm', level: 4, description: 'a colossal sandworm emerging from dark depths with rings of teeth' },
  { id: 33, name: 'Turtapod', level: 4, description: 'a mechanical turtle fortress with cannon turrets on its shell' },
  { id: 34, name: 'Vysage', level: 4, description: 'a floating demonic mask trinity of connected faces' },
  { id: 35, name: 'T-Rexaur', level: 4, description: 'a fearsome tyrannosaurus with electric blue markings' },
  { id: 36, name: 'Bomb', level: 4, description: 'a flaming sphere creature about to explode with fire energy' },
  { id: 37, name: 'Blitz', level: 4, description: 'a lightning elemental beast crackling with raw electrical energy' },
  { id: 38, name: 'Wendigo', level: 4, description: 'a massive frost ape with icy fur and frozen breath' },
  { id: 39, name: 'Torama', level: 4, description: 'a sleek panther-like creature with whip-like tentacles' },
  { id: 40, name: 'Imp', level: 4, description: 'a mischievous winged imp with a trident and magical aura' },

  // Level 5 - Legendary creatures
  { id: 41, name: 'Blue Dragon', level: 5, description: 'a magnificent azure dragon with crystalline scales and lightning breath' },
  { id: 42, name: 'Abadon', level: 5, description: 'a demonic worm-dragon of the abyss wreathed in dark flames' },
  { id: 43, name: 'Iron Giant', level: 5, description: 'a towering ancient iron colossus wielding a massive sword' },
  { id: 44, name: 'Behemoth', level: 5, description: 'a gargantuan purple beast with enormous horns and cosmic power' },
  { id: 45, name: 'Chimera', level: 5, description: 'a three-headed mythical beast combining lion eagle and serpent' },
  { id: 46, name: 'PuPu', level: 5, description: 'a cute small blue alien creature with large innocent eyes' },
  { id: 47, name: 'Elastoid', level: 5, description: 'a futuristic mechanical spider drone with energy weapons' },
  { id: 48, name: 'GIM47N', level: 5, description: 'a heavy combat mech with arm cannons and armored plating' },
  { id: 49, name: 'Malboro', level: 5, description: 'a horrific tentacle plant with an enormous mouth full of fangs' },
  { id: 50, name: 'Ruby Dragon', level: 5, description: 'a crimson dragon wreathed in flames with ruby-encrusted scales' },
];

function getStyleForLevel(level: number): string {
  switch (level) {
    case 1: return 'muted earthy tones, simple composition';
    case 2: return 'cool blue and teal tones, moderate detail';
    case 3: return 'vivid purple and gold tones, intricate detail';
    case 4: return 'fiery orange and deep crimson tones, dramatic lighting';
    case 5: return 'brilliant gold and cosmic purple tones, epic composition with particle effects';
    default: return '';
  }
}

function buildPrompt(card: CardInfo): string {
  return `Fantasy trading card art of ${card.description}. Dark mystical background with Aztec-inspired geometric border patterns. ${getStyleForLevel(card.level)}. Digital painting style, highly detailed, centered composition on solid dark background. Square format.`;
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
