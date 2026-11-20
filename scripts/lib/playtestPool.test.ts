/**
 * Which pool entries belong to the deployment under test.
 *
 *   npx vitest run scripts/lib/playtestPool.test.ts
 *
 * The harness used to claim the first unused entry, whatever chain or NFT it
 * was provisioned for. After the v6 move (20 Nov 2026) the pool held 4 unused
 * entries from the dead 5.2 chain after the 2 fresh ones; the next run would
 * have seeded a browser with cards that exist nowhere.
 */
import { describe, it, expect } from 'vitest';
import { claimNext, countClaimable, entryStatus, nextFreeIndex, type Deployment } from '../../packages/playtest/src/playtestPool';

const NFT = '0x1c0554f341edab543537458916b973c1e455c2f0cd5a0e132ce1223ecac6aa80';
const OLD_NFT = '0x' + '0b'.repeat(32);
const RV = 679261766;
const OLD_RV = 1821665230;
const here: Deployment = { rollupVersion: RV, nftAddress: NFT };

const entry = (index: number, used: boolean, rollupVersion?: number, nftAddress?: string) =>
  ({ index, used, rollupVersion, nftAddress });

describe('entryStatus', () => {
  it('is current only when both the chain and the NFT match', () => {
    expect(entryStatus(entry(0, false, RV, NFT), here)).toBe('current');
  });

  it('compares addresses case-insensitively', () => {
    expect(entryStatus(entry(0, false, RV, NFT.toUpperCase().replace('0X', '0x')), here)).toBe('current');
  });

  it('marks another chain stale even when the NFT address matches', () => {
    expect(entryStatus(entry(0, false, OLD_RV, NFT), here)).toBe('other-deployment');
  });

  it('marks a previous NFT on the same chain stale — the redeploy case a chain stamp misses', () => {
    expect(entryStatus(entry(0, false, RV, OLD_NFT), here)).toBe('other-deployment');
  });

  it('marks an entry with no chain stamp at all stale', () => {
    expect(entryStatus(entry(0, false), here)).toBe('other-deployment');
  });

  it('cannot place a same-chain entry with no NFT stamp', () => {
    expect(entryStatus(entry(0, false, RV), here)).toBe('unstamped');
  });
});

describe('claimNext', () => {
  // The manifest as the v6 cutover left it: two fresh v6 accounts (now used),
  // ten used 5.2 accounts, then four UNUSED 5.2 accounts.
  const afterCutover = () => [
    entry(0, true, RV, NFT),
    entry(1, true, RV, NFT),
    ...Array.from({ length: 10 }, (_, i) => entry(i + 2, true, OLD_RV)),
    ...Array.from({ length: 4 }, (_, i) => entry(i + 12, false, OLD_RV)),
  ];

  it('refuses to hand out another chain\'s unused accounts', () => {
    const pool = afterCutover();
    expect(() => claimNext(pool, NFT)).toThrow(/No unused playtest account for this deployment/);
    expect(pool.filter((e) => !e.used)).toHaveLength(4); // nothing was consumed
  });

  it('points at the next free index', () => {
    expect(() => claimNext(afterCutover(), NFT)).toThrow(/--start 16 --count <N>/);
  });

  it('skips stale unused entries ahead of a current one, and marks the claim used', () => {
    const pool = [...afterCutover(), entry(16, false, RV, NFT)];
    const claimed = claimNext(pool, NFT);
    expect(claimed.index).toBe(16);
    expect(claimed.used).toBe(true);
    expect(pool.find((e) => e.index === 12)!.used).toBe(false);
  });

  it('never claims an entry minted on another NFT, or one with no NFT stamp', () => {
    const pool = [entry(0, false, RV, OLD_NFT), entry(1, false, RV), entry(2, false, RV, NFT)];
    expect(claimNext(pool, NFT).index).toBe(2);
  });
});

describe('pool top-up arithmetic', () => {
  it('counts only unused entries minted on this NFT', () => {
    const pool = [
      entry(0, true, RV, NFT), entry(1, false, RV, NFT), entry(2, false, RV, OLD_NFT),
      entry(3, false, RV), entry(4, false, OLD_RV), entry(5, false, RV, NFT.toUpperCase().replace('0X', '0x')),
    ];
    expect(countClaimable(pool, NFT)).toBe(2);
  });

  it('provisions at the first index nothing has used, so keys are never reused', () => {
    expect(nextFreeIndex([])).toBe(0);
    expect(nextFreeIndex([entry(0, true), entry(7, false), entry(3, true)])).toBe(8);
  });
});
