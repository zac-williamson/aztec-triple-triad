import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBotIdentity } from '../src/BotChain.js';

const validManifest = {
  index: 0, address: '0xabc', secret: '0x1', salt: '0x2', signingKey: '0x3',
  cardIds: [1, 2, 3, 4, 5], rollupVersion: 123, provisionedAt: 'now',
};

function manifestFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'botchain-'));
  const path = join(dir, 'arena-bot.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('loadBotIdentity', () => {
  it('loads a provisioned manifest', () => {
    const id = loadBotIdentity(manifestFile(validManifest));
    expect(id.address).toBe('0xabc');
    expect(id.cardIds).toHaveLength(5);
    expect(id.rollupVersion).toBe(123);
  });

  it('tells you how to provision when the manifest is absent', () => {
    expect(() => loadBotIdentity('/nonexistent/arena-bot.json'))
      .toThrow(/manifest not found.*provision-arena-bot/s);
  });

  it('rejects a manifest missing any key rather than half-connecting', () => {
    for (const key of ['address', 'secret', 'salt', 'signingKey']) {
      const broken: any = { ...validManifest };
      delete broken[key];
      expect(() => loadBotIdentity(manifestFile(broken)), key).toThrow(new RegExp(`missing '${key}'`));
    }
  });
});
