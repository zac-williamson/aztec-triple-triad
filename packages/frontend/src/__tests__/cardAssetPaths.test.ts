import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Card art ships exclusively as .webp (PNG originals were removed in the
// asset-diet pass, F1). A PNG reference under the cards dir in frontend
// source is a 404 at runtime, so fail fast here instead.
const SRC_ROOT = join(__dirname, '..');
const CARD_PNG_REF = /["'`/]cards\/[^"'`]*\.png/;

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFilesUnder(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('card asset paths', () => {
  it('no frontend source references a /cards/ PNG', () => {
    const offenders = sourceFilesUnder(SRC_ROOT)
      .filter((file) => CARD_PNG_REF.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
