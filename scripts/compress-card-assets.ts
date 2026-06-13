#!/usr/bin/env npx tsx
/**
 * Resize + convert card PNGs to WebP next to the originals.
 *
 * Safe to run repeatedly — skips files whose .webp is newer than the .png.
 * Does NOT delete the source PNGs (do that separately after you've verified
 * the output in the browser).
 *
 * Targets:
 *   public/cards/final/card-*.png     → card-*.webp   (400×567, q80)
 *   public/cards/board/card-*-board.png → card-*-board.webp (512×512, q85)
 *   public/cards/card_back.png        → card_back.webp (400×567, q80)
 *
 * Usage:
 *   npx tsx scripts/compress-card-assets.ts            # do the work
 *   npx tsx scripts/compress-card-assets.ts --dry-run  # report only, no writes
 *   npx tsx scripts/compress-card-assets.ts --force    # regen even if .webp exists
 *   npx tsx scripts/compress-card-assets.ts --only final   # just one group
 */

import { readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';

interface Variant {
  name: string;
  inputDir: string;
  inputSuffix: string;      // e.g. '.png' or '-board.png'
  outputSuffix: string;     // e.g. '.webp' or '-board.webp'
  width: number;
  height: number;
  quality: number;
  fit: 'cover' | 'inside';
}

const ROOT = resolve(import.meta.dirname || __dirname, '..');
const PUBLIC = join(ROOT, 'packages/frontend/public');

const VARIANTS: Variant[] = [
  {
    name: 'final',
    inputDir: join(PUBLIC, 'cards/final'),
    inputSuffix: '.png',
    outputSuffix: '.webp',
    width: 400,
    height: 567,
    quality: 80,
    fit: 'inside',
  },
  {
    name: 'board',
    inputDir: join(PUBLIC, 'cards/board'),
    inputSuffix: '-board.png',
    outputSuffix: '-board.webp',
    width: 512,
    height: 512,
    quality: 85,
    fit: 'inside',
  },
  {
    name: 'card_back',
    inputDir: join(PUBLIC, 'cards'),
    inputSuffix: 'card_back.png',
    outputSuffix: 'card_back.webp',
    width: 400,
    height: 567,
    quality: 80,
    fit: 'inside',
  },
];

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE = argv.has('--force');
const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length)
  ?? (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 ** 2).toFixed(2)}MB`;
}

async function processVariant(v: Variant): Promise<{ totalIn: number; totalOut: number; count: number; skipped: number }> {
  let totalIn = 0;
  let totalOut = 0;
  let count = 0;
  let skipped = 0;

  const files = readdirSync(v.inputDir)
    .filter(f => f.endsWith(v.inputSuffix))
    .sort();

  console.log(`\n[${v.name}] ${files.length} files from ${v.inputDir}`);
  console.log(`         → ${v.width}×${v.height} ${v.fit} @ quality ${v.quality}`);

  for (const file of files) {
    const inputPath = join(v.inputDir, file);
    const outputName = file.slice(0, -v.inputSuffix.length) + v.outputSuffix;
    const outputPath = join(v.inputDir, outputName);

    const inStat = statSync(inputPath);
    totalIn += inStat.size;

    let outStat: ReturnType<typeof statSync> | null = null;
    try {
      outStat = statSync(outputPath);
    } catch {}

    const outputIsFresh = !!outStat && outStat.mtimeMs >= inStat.mtimeMs;
    if (outputIsFresh && !FORCE) {
      totalOut += outStat!.size;
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  would write ${outputName}`);
      count++;
      continue;
    }

    const img = sharp(inputPath).resize({
      width: v.width,
      height: v.height,
      fit: v.fit,
      withoutEnlargement: true,
    });
    await img.webp({ quality: v.quality, effort: 6 }).toFile(outputPath);
    const newStat = statSync(outputPath);
    totalOut += newStat.size;
    count++;

    if (count % 20 === 0 || count === files.length - skipped) {
      console.log(`  ${count + skipped}/${files.length} (last: ${file} → ${fmtBytes(newStat.size)})`);
    }
  }

  return { totalIn, totalOut, count, skipped };
}

async function main() {
  if (DRY_RUN) console.log('(dry-run — no files will be written)');
  const toRun = onlyArg ? VARIANTS.filter(v => v.name === onlyArg) : VARIANTS;
  if (onlyArg && toRun.length === 0) {
    console.error(`Unknown --only value: ${onlyArg}. Valid: ${VARIANTS.map(v => v.name).join(', ')}`);
    process.exit(1);
  }

  let grandIn = 0;
  let grandOut = 0;
  for (const v of toRun) {
    const { totalIn, totalOut, count, skipped } = await processVariant(v);
    console.log(`  → ${count} written, ${skipped} up-to-date`);
    console.log(`  → in:  ${fmtBytes(totalIn)}`);
    console.log(`  → out: ${fmtBytes(totalOut)} (${totalIn ? ((totalOut / totalIn) * 100).toFixed(1) : '0'}%)`);
    grandIn += totalIn;
    grandOut += totalOut;
  }

  console.log('\n===============================');
  console.log(`Total input:  ${fmtBytes(grandIn)}`);
  console.log(`Total output: ${fmtBytes(grandOut)}`);
  if (grandIn > 0) {
    console.log(`Reduction:    ${((1 - grandOut / grandIn) * 100).toFixed(1)}%  (saved ${fmtBytes(grandIn - grandOut)})`);
  }
  console.log('\nNext steps:');
  console.log('  1. spot-check a few .webp files in Preview / browser');
  console.log('  2. update Card.tsx + Card3D.tsx to reference .webp');
  console.log('  3. delete the .png originals once you’re happy');
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
