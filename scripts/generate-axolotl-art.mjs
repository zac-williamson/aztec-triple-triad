#!/usr/bin/env node
/**
 * Axolotl Card Art Generator
 *
 * Generates 50 unique axolotl illustrations using DALL-E 3 with a consistent
 * painterly fantasy art style. Each card gets a unique description based on
 * its name and rarity tier.
 *
 * Usage:
 *   node scripts/generate-axolotl-art.mjs              # generate all missing
 *   node scripts/generate-axolotl-art.mjs 1 5 25       # generate specific IDs
 *   node scripts/generate-axolotl-art.mjs --force 1    # regenerate even if exists
 *
 * Output: packages/frontend/public/cards/card-<id>.png
 */

import OpenAI from 'openai';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

// ── Config ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const API_KEY_PATH = '/Users/zac/aztec-triple-triad/OPEN_API_KEY.txt';
const OUTPUT_DIR = path.resolve(ROOT, 'packages/frontend/public/cards');

const apiKey = readFileSync(API_KEY_PATH, 'utf-8').trim();
const openai = new OpenAI({ apiKey });

// ── Embellishment system prompt (Renaissance art director) ──────────────

const EMBELLISHER_SYSTEM = `You are a Renaissance master painter turned fantasy art director. Your job is to take a brief creature description and transform it into a rich, evocative DALL-E prompt that will produce a stunning painterly portrait.

Apply these classical painting principles:
- CHIAROSCURO: dramatic interplay of light and shadow, Caravaggio-style contrast
- SFUMATO: soft, smoky transitions between colors and edges, Leonardo da Vinci technique
- IMPASTO: thick, textured brushstrokes that give dimensionality, like Rembrandt
- GLAZING: luminous layered color, as if light passes through translucent oil paint
- TENEBRISM: figures emerging from deep shadow with dramatic spotlighting

Composition rules:
- The creature must be CENTERED and fill ~65% of the square canvas
- Edge-to-edge artwork, NO border, NO frame, NO vignette, NO decorative edges
- The background should be a moody swamp/mystical atmosphere with depth and bokeh
- Dramatic rim lighting with warm highlights catching the creature's wet skin

CRITICAL constraints you MUST include verbatim at the END of every prompt:
"Edge-to-edge painting with no border, no frame, no vignette. No text, no words, no letters, no numbers, no watermark, no UI elements."

Output ONLY the final DALL-E prompt. No preamble, no explanation. Keep it under 350 words.`;

// ── Embellish a card description via GPT-4o ─────────────────────────────

async function embellishPrompt(cardName, baseDescription, rarity) {
  const userMsg = `Create a DALL-E prompt for a fantasy trading card portrait of an axolotl creature.

Card name: "${cardName}"
Rarity tier: ${rarity}
Base description: ${baseDescription}

${rarity === 'legendary' ? 'This is the highest rarity — make it awe-inspiring, mythical, with overwhelming magical energy.' : ''}
${rarity === 'epic' ? 'This is a high rarity — dramatic magical effects, strong aura, impressive presence.' : ''}
${rarity === 'rare' ? 'This is mid-rarity — subtle magical accents, glowing details, atmospheric.' : ''}
${rarity === 'uncommon' ? 'This is low-mid rarity — distinct and stylized but grounded, minimal magic.' : ''}
${rarity === 'common' ? 'This is the lowest rarity — natural, simple, no magical effects. Focus on earthy realism.' : ''}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: EMBELLISHER_SYSTEM },
      { role: 'user', content: userMsg },
    ],
    max_tokens: 600,
    temperature: 0.8,
  });

  return response.choices[0].message.content.trim();
}

function getRarity(id) {
  if (id <= 10) return 'common';
  if (id <= 20) return 'uncommon';
  if (id <= 30) return 'rare';
  if (id <= 40) return 'epic';
  return 'legendary';
}

// ── Per-card descriptions ───────────────────────────────────────────────
// Each entry: [id, name, description]
// Rarity tiers escalate visual complexity:
//   Common (1-10):     natural colors, simple poses, no magic
//   Uncommon (11-20):  distinct patterns, subtle stylization
//   Rare (21-30):      glowing accents, magical particles
//   Epic (31-40):      strong aura, dramatic effects
//   Legendary (41-50): intense energy, mythical radiance

const CARD_DESCRIPTIONS = [
  // ── Common (1-10) ──
  [1, 'Mudwalker',
    'An earthy brown axolotl with tan and ochre spots scattered across its back. Resting on a mossy rock beside murky water. Warm natural tones, gentle sleepy expression, soft ambient swamp light.'],
  [2, 'Blushy',
    'A soft pink axolotl with rosy red cheeks and a shy, endearing smile. Pale cream underbelly, delicate coral-colored gills. Sitting among water lilies, warm pastel lighting.'],
  [3, 'Snowdrop',
    'A pristine white axolotl with pale blue tints on its gill fronds. Crystal-clear droplets on its skin, resting on a frosted leaf. Cool blue-white color palette, serene expression.'],
  [4, 'Sunny',
    'A bright golden-yellow axolotl with warm amber eyes. Orange-tipped gills radiating warmth. Basking on a sun-dappled stone, cheerful expression, golden hour lighting.'],
  [5, 'Inkwell',
    'A deep midnight-black axolotl with subtle dark blue iridescence on its skin. Small white speckles like ink droplets. Dark moody atmosphere, perched on driftwood.'],
  [6, 'Stripes',
    'A forest-green axolotl with bold darker green horizontal stripes along its body. Vivid lime-green gills. Alert posture on a reed, natural swamp greens palette.'],
  [7, 'Barkeeper',
    'A warm russet-brown axolotl with a stocky build and amber-gold belly. Small darker freckles on its face. Sitting contentedly on a wooden barrel, tavern-warm amber lighting.'],
  [8, 'Dotty',
    'A slate-blue axolotl covered in perfectly round white polka dots. Bright teal gills, curious wide-eyed expression. Peeking from behind a large mushroom, cool blue palette.'],
  [9, 'Penny',
    'A copper-colored axolotl with a metallic sheen to its smooth skin. Dark bronze gills, wise contemplative expression. Resting on river pebbles, warm copper-gold tones.'],
  [10, 'Peaches',
    'A soft peach and cream colored axolotl with blush-orange gills. Round plump body, content happy expression. Lounging among peach-colored flowers, warm sunset palette.'],

  // ── Uncommon (11-20) ──
  [11, 'Freckles',
    'A tawny orange axolotl densely covered in small brown freckle-like spots across its entire body. Bright amber gills with spotted patterns. Playful expression, perched on a vine, dappled forest light.'],
  [12, 'Camo',
    'A camouflage-patterned axolotl with irregular patches of olive green, dark brown, and tan. Blending into swamp foliage, only its bright yellow eyes visible. Military green palette, jungle atmosphere.'],
  [13, 'Neon',
    'A vivid electric-green axolotl with bright chartreuse highlights and fluorescent yellow gill fronds. Almost glowing against the dark swamp background. High contrast, vibrant neon color palette.'],
  [14, 'Glow Bug',
    'A dark teal axolotl with bioluminescent spots along its sides that emit a soft green-yellow glow. Fireflies dancing around it in the misty darkness. Atmospheric night scene.'],
  [15, 'Limelight',
    'A bright lime-green axolotl with a flashy yellow crest and dramatic fanned-out gills. Confident forward-facing pose as if performing. Vibrant stage-like lighting, yellow-green palette.'],
  [16, 'Marble',
    'A striking axolotl with swirled patterns of white and deep grey, like polished marble stone. Smooth lustrous skin, elegant composed posture. Cool grey tones with silver highlights.'],
  [17, 'Sapphire',
    'A rich royal-blue axolotl with crystalline sapphire-blue highlights on its gill tips. Deep ocean-blue body, gem-like quality to its eyes. Cool jewel-tone palette, slight sparkle.'],
  [18, 'Jefferson',
    'A distinguished dark olive-green axolotl with golden spectacle-like markings around its eyes. Dignified upright posture, wise expression. Vintage warm tones, scholarly atmosphere.'],
  [19, 'Longfoot',
    'A sleek lavender-grey axolotl with notably elongated limbs and toes. Graceful stretched pose, athletic build. Subtle purple tones, elegant and agile appearance.'],
  [20, 'Featherfin',
    'An elegant teal axolotl with extraordinarily large, feathery gill fronds that flow like plumes. Soft flowing movement captured mid-swim. Aquamarine palette, dreamy underwater feel.'],

  // ── Rare (21-30) ──
  [21, 'Lilac',
    'A beautiful soft purple axolotl with delicate lilac-colored gills that shimmer with faint magical light. Tiny glowing violet particles drift around it. Ethereal purple-lavender palette, moonlit atmosphere.'],
  [22, 'Patches',
    'A patchwork axolotl with distinct sections of different colors—cream, brown, grey, and amber—like a calico cat. Each patch has a faint magical glow at the seams. Warm eclectic palette.'],
  [23, 'Faded',
    'A hauntingly beautiful axolotl whose colors seem to fade from vivid turquoise at the head to near-transparent at the tail. Ghostly wisps trail from its gills. Gradient fade effect, mysterious atmosphere.'],
  [24, 'Gold Dust',
    'A deep burgundy axolotl with skin dusted in shimmering gold particles, as if sprinkled with magical gold powder. Its gills sparkle with golden light. Rich crimson and gold palette, treasure-like glow.'],
  [25, 'Phantom',
    'A translucent ghostly-white axolotl with a faint blue inner glow, as if made of moonlight. Ethereal wisps curl from its gill fronds. Semi-transparent body, haunting pale blue atmosphere.'],
  [26, 'Ash',
    'A storm-grey axolotl with smoldering orange cracks along its skin, like cooling volcanic ash. Faint embers drift from its gills. Dark grey with glowing orange veins, smoky atmosphere.'],
  [27, 'Cocoa',
    'A rich dark chocolate-brown axolotl with warm cream swirl patterns, like cocoa and milk blending. Faint warm golden glow emanating from within. Deep brown and cream palette, cozy magical warmth.'],
  [28, 'Ringmaster',
    'A dramatic black and white axolotl with bold concentric ring patterns on its skin. Red-tipped gills like a circus performer. Theatrical spotlight lighting, dramatic black-white-red palette.'],
  [29, 'Goldrush',
    'A gleaming golden axolotl with metallic gold skin that catches the light brilliantly. Nugget-like bumps along its back sparkle. Luminous gold palette, prospector-era warm lighting.'],
  [30, 'Swampling',
    'A deep mossy-green axolotl that seems to grow small ferns and tiny mushrooms on its back. Symbiotic with the swamp itself. Living ecosystem on its skin, deep green nature palette.'],

  // ── Epic (31-40) ──
  [31, 'Glitter',
    'A magnificent axolotl whose entire body is covered in prismatic glitter that refracts light into rainbow spectrums. Cascading sparkles trail from its movement. Holographic rainbow effect, dazzling magical aura.'],
  [32, 'Starfield',
    'A deep space-black axolotl with a galaxy of tiny stars and nebulae visible within its translucent skin. Cosmic swirls of purple and blue. Its body contains the night sky itself, cosmic aura.'],
  [33, 'Specter',
    'A terrifying spectral axolotl made of swirling dark smoke and green ghostfire. Hollow glowing green eyes, phantom tendrils trailing from its form. Supernatural horror atmosphere, dark emerald energy.'],
  [34, 'Saffron',
    'A luxurious deep saffron-orange axolotl with intricate golden filigree patterns naturally formed on its skin. Royal bearing, warm magical aura. Rich spice-trade palette, ornate and precious.'],
  [35, 'Stardust',
    'A celestial white axolotl with black patches that contain swirling golden stardust. Cosmic particles orbit its body. Part of the universe made flesh. Black and gold cosmic palette, stellar magical energy.'],
  [36, 'Achoque',
    'An ancient-looking axolotl with weathered obsidian-black skin covered in glowing turquoise Aztec geometric patterns. Primal elemental power, jade and obsidian palette, ancient Mesoamerican mystical energy.'],
  [37, 'Zacapu',
    'A majestic deep indigo axolotl with bioluminescent cyan markings forming sacred water symbols. Surrounded by floating droplets of glowing water. Aztec lake spirit, deep blue mystical aura.'],
  [38, 'Laguna',
    'A serene aquamarine axolotl with crystalline transparent fins that refract light into prismatic patterns. Surrounded by floating crystal water spheres. Peaceful yet powerful, oceanic magical energy.'],
  [39, 'Streamwalker',
    'A sleek silver-blue axolotl that appears to be partially made of flowing water. Streams of luminous water flow along its body and trail behind it. Fluid mercury-silver palette, water elemental energy.'],
  [40, 'Digger',
    'A powerful earth-brown axolotl with rough stone-like armor plating and glowing amber crystal formations growing from its back. Underground cavern atmosphere, amber crystal magical energy radiating outward.'],

  // ── Legendary (41-50) ──
  [41, 'Eclipse',
    'A breathtaking axolotl of pure darkness with a brilliant solar corona radiating from behind it. Golden light blazes from its gill fronds like solar flares. The body is a dark void rimmed with blinding golden radiance. Overwhelming celestial power.'],
  [42, 'Kaleidoscope',
    'A mesmerizing axolotl whose skin constantly shifts between every color of the spectrum in geometric fractal patterns. Prismatic light radiates outward, casting rainbow reflections. Reality-bending chromatic energy, hypnotic and otherworldly.'],
  [43, 'Twinned',
    'A mystical two-headed axolotl—one head white as moonlight, the other black as shadow. Where they meet, yin-yang energy swirls. Duality incarnate, black and white magical energy intertwining in perfect balance.'],
  [44, 'Sparkletail',
    'A magnificent axolotl with a massively long tail that blazes with cascading magical sparks like a comet trail. Deep violet body with its spectacular tail showering golden and silver sparks. Pyrotechnic legendary energy.'],
  [45, 'Riddler',
    'An enigmatic axolotl covered in shifting mystical runes and symbols that glow and rearrange across its dark grey skin. Multiple glowing eyes peer from different angles. Arcane mystery, ancient runic magical energy.'],
  [46, 'Rosita',
    'A divine rose-pink axolotl surrounded by an aura of blooming magical roses and cherry blossoms. Petals swirl in a vortex of pink and gold energy. Floral goddess energy, breathtakingly beautiful, radiant pink-gold power.'],
  [47, 'Brooklet',
    'A legendary water-spirit axolotl whose body is made entirely of crystalline flowing water, perfectly clear with dancing light refractions inside. Floating above a sacred spring, pure elemental water given sentient form. Luminous aquatic energy.'],
  [48, 'Whisper',
    'An ethereal nearly-invisible axolotl made of mist and whispered secrets. Faint silver outlines and ghostly blue eyes are all that is visible. Words in an ancient script float and dissolve around it. Transcendent spectral energy.'],
  [49, 'Misty',
    'A legendary axolotl that emerges from dense magical fog, its body half-revealed in swirling silver and pearl mist. Where the mist clears, opalescent scales shimmer with inner light. Mystical fog elemental, pearlescent radiance.'],
  [50, 'Lerma',
    'A titanic legendary axolotl with ancient weathered skin bearing glowing green Aztec calendar markings. Sacred jade and gold energy emanates from within. The spirit guardian of an ancient lake, primordial power, jade-green mythical radiance.'],
];

// ── Image download helper ───────────────────────────────────────────────

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Generate a single card ──────────────────────────────────────────────

async function generateCard(id, name, description) {
  // Step 1: Embellish via GPT-4o Renaissance art director
  const rarity = getRarity(id);
  console.log(`    [GPT-4o] Embellishing prompt (${rarity})...`);
  const embellished = await embellishPrompt(name, description, rarity);
  console.log(`    [GPT-4o] ${embellished.slice(0, 100)}...`);

  // Step 2: Generate with DALL-E 3
  console.log(`    [DALL-E] Generating image...`);
  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: embellished,
    n: 1,
    size: '1024x1024',
    quality: 'hd',
    style: 'vivid',
  });

  const imageUrl = response.data[0].url;
  const imageData = await downloadImage(imageUrl);

  // Save the embellished prompt alongside the image for reference
  const promptPath = path.join(OUTPUT_DIR, `card-${id}.prompt.txt`);
  writeFileSync(promptPath, embellished);

  const outputPath = path.join(OUTPUT_DIR, `card-${id}.png`);
  writeFileSync(outputPath, imageData);

  return outputPath;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Axolotl Card Art Generator (DALL-E 3)');
  console.log('======================================\n');

  // Parse CLI args
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const requestedIds = args.filter(a => a !== '--force').map(Number).filter(n => n > 0);

  // Filter cards to generate
  let cards = CARD_DESCRIPTIONS;
  if (requestedIds.length > 0) {
    cards = cards.filter(([id]) => requestedIds.includes(id));
  }

  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  // Skip existing unless --force
  if (!force) {
    const before = cards.length;
    cards = cards.filter(([id]) => !existsSync(path.join(OUTPUT_DIR, `card-${id}.png`)));
    if (before !== cards.length) {
      console.log(`Skipping ${before - cards.length} cards that already exist (use --force to regenerate)\n`);
    }
  }

  if (cards.length === 0) {
    console.log('All cards already exist. Use --force to regenerate.');
    return;
  }

  console.log(`Generating ${cards.length} card(s)...\n`);

  // DALL-E 3 rate limits: ~5 images/minute for most tiers
  // Process sequentially with a delay between requests
  let success = 0;
  let failed = 0;
  const DELAY_MS = 13000; // ~13s between requests to stay under rate limits

  for (let i = 0; i < cards.length; i++) {
    const [id, name, description] = cards[i];

    try {
      console.log(`  [${i + 1}/${cards.length}] Card ${id} (${name})...`);
      const outputPath = await generateCard(id, name, description);
      console.log(`    -> ${path.basename(outputPath)}`);
      success++;

      // Rate limit delay (skip after last card)
      if (i < cards.length - 1) {
        process.stdout.write(`    Waiting ${DELAY_MS / 1000}s for rate limit...`);
        await new Promise(r => setTimeout(r, DELAY_MS));
        process.stdout.write(' ok\n');
      }
    } catch (err) {
      const msg = err?.error?.message || err?.message || String(err);
      console.error(`    FAILED: ${msg}`);
      failed++;

      // If rate limited, wait longer and retry once
      if (msg.includes('rate') || msg.includes('Rate') || msg.includes('429')) {
        console.log('    Rate limited — waiting 60s before retry...');
        await new Promise(r => setTimeout(r, 60000));
        try {
          const outputPath = await generateCard(id, name, description);
          console.log(`    -> Retry succeeded: ${path.basename(outputPath)}`);
          success++;
          failed--;
        } catch (retryErr) {
          console.error(`    Retry also failed: ${retryErr?.error?.message || retryErr?.message}`);
        }
      }
    }
  }

  console.log(`\nDone: ${success} generated, ${failed} failed`);
  console.log(`Output: ${OUTPUT_DIR}`);

  if (success > 0) {
    console.log('\nRun the card compositor to create final cards with frames:');
    console.log('  node scripts/generate-card-graphics.mjs');
  }
}

main().catch(console.error);
