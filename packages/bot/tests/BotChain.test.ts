import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBotIdentity, BotChain } from '../src/BotChain.js';

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

describe('collection caching', () => {
  /**
   * readPrivateCards pages the collection ten cards at a time, so it costs
   * O(cards) sequential simulations — about 46 seconds at 1,382 cards. The bot
   * polls every two seconds, so re-reading on every poll enqueued that
   * 46-second operation 23x faster than the single serial PXE queue could
   * drain it. A join then waited behind 21 of them: sixteen minutes measured in
   * production, for a transaction that takes forty-four seconds.
   */
  function chainWith(reads: { n: number }) {
    const chain = new BotChain(
      { pxeUrl: 'http://x', nftAddress: '0x1', gameAddress: '0x2', manifestPath: '/nonexistent' },
      () => {},
    );
    // `pxe` is a getter on BotChain, so substitute the getter itself. The
    // paging read is what the cache exists to avoid; counting calls is the test.
    Object.defineProperty(chain, 'pxe', {
      configurable: true,
      get: () => ({
        readPrivateCards: async () => { reads.n += 1; return [1, 2, 3, 4, 5, 6]; },
      }),
    });
    (chain as unknown as { identity: unknown }).identity = { address: '0xbot' };
    return chain;
  }

  it('reads once and serves the rest from cache', async () => {
    const reads = { n: 0 };
    const chain = chainWith(reads);
    for (let i = 0; i < 20; i++) await chain.readCards();
    expect(reads.n, 'twenty polls cost one page-through').toBe(1);
  });

  it('pays for a fresh read once cards have moved', async () => {
    const reads = { n: 0 };
    const chain = chainWith(reads);
    await chain.readCards();
    chain.invalidateCards();
    await chain.readCards();
    expect(reads.n).toBe(2);
  });

  it('forces a read when the caller demands one', async () => {
    const reads = { n: 0 };
    const chain = chainWith(reads);
    await chain.readCards();
    await chain.readCards({ force: true });
    expect(reads.n).toBe(2);
  });

  it('keeps the cached count in step with what it read', async () => {
    const reads = { n: 0 };
    const chain = chainWith(reads);
    await chain.readCards();
    expect(chain.lastKnownCardCount).toBe(6);
  });
});
