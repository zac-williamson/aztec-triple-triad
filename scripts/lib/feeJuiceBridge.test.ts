/**
 * Unit tests for the Fee Juice bridging helpers.
 *
 *   npm run test:scripts                                  # all script tests
 *   npx vitest run scripts/lib/feeJuiceBridge.test.ts     # just this file
 *
 * Covers the pure logic (arg parsing, claim serialize/deserialize round-trip,
 * claim-store persistence). The live bridge is exercised only when
 * TESTNET_L1_RPC_URL + TREASURY_L1_KEY are set (needs Sepolia), mirroring the
 * integration e2e env-gating — otherwise that test is skipped.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parseL2Addresses,
  parseChainIdHex,
  serializeClaim,
  deserializeClaim,
  claimStorePath,
  putStoredClaim,
  getStoredClaim,
  loadClaimStore,
  markClaimConsumed,
  readFunderKey,
  type FeeJuiceClaim,
} from './feeJuiceBridge';

const ADDR_A = '0x' + '11'.repeat(32);
const ADDR_B = '0x' + 'ab'.repeat(32);

// A tiny Fr stand-in so the pure (de)serialize logic is testable without the SDK.
const FakeFr = { fromHexString: (h: string) => ({ _hex: h, toString: () => h }) };

describe('feeJuiceBridge helpers', () => {
  it('parseL2Addresses: accepts addresses, skips flags', () => {
    expect(parseL2Addresses([ADDR_A, '--mint', ADDR_B])).toEqual([ADDR_A, ADDR_B]);
  });

  it('parseL2Addresses: lowercases', () => {
    expect(parseL2Addresses(['0x' + 'AB'.repeat(32)])).toEqual(['0x' + 'ab'.repeat(32)]);
  });

  it('parseL2Addresses: empty -> empty', () => {
    expect(parseL2Addresses(['--only', '--flags'])).toEqual([]);
  });

  it('parseL2Addresses: rejects a malformed address loudly', () => {
    expect(() => parseL2Addresses(['0xdeadbeef'])).toThrow(/Not a valid L2 address/);
    expect(() => parseL2Addresses([ADDR_A.slice(0, -2)])).toThrow(/Not a valid L2 address/);
  });

  it('parseChainIdHex: Sepolia + Anvil, rejects garbage', () => {
    expect(parseChainIdHex('0xaa36a7')).toBe(11155111); // Sepolia
    expect(parseChainIdHex('0x7a69')).toBe(31337); // Anvil
    expect(() => parseChainIdHex('0x0')).toThrow(/Invalid eth_chainId/);
    expect(() => parseChainIdHex('nonsense')).toThrow(/Invalid eth_chainId/);
  });

  it('serialize/deserialize: round-trips claim shape', () => {
    const claim: FeeJuiceClaim = {
      claimAmount: 1_000_000_000_000n,
      claimSecret: { toString: () => '0x' + '0a'.repeat(32) },
      claimSecretHash: { toString: () => '0x' + '0b'.repeat(32) },
      messageHash: '0x' + 'cd'.repeat(32),
      messageLeafIndex: 42n,
    };
    const s = serializeClaim(ADDR_A, claim, '2026-06-12T00:00:00Z');
    expect(s.status).toBe('pending');
    expect(s.claimAmount).toBe('1000000000000');
    expect(s.messageLeafIndex).toBe('42');
    expect(s.l2Address).toBe(ADDR_A);

    // JSON survives a stringify/parse (it gets persisted as JSON).
    const back = deserializeClaim(JSON.parse(JSON.stringify(s)), FakeFr);
    expect(back.claimAmount).toBe(1_000_000_000_000n);
    expect(back.messageLeafIndex).toBe(42n);
    expect(back.claimSecret.toString()).toBe('0x' + '0a'.repeat(32));
    expect(back.messageHash).toBe('0x' + 'cd'.repeat(32));
  });

  it('deserialized claim has the fields FeeJuicePaymentMethodWithClaim needs', () => {
    // The SDK ctor wants Pick<L2AmountClaim,'claimAmount'|'claimSecret'|'messageLeafIndex'>.
    const s = serializeClaim(
      ADDR_A,
      {
        claimAmount: 7n,
        claimSecret: { toString: () => '0x' + '01'.repeat(32) },
        claimSecretHash: { toString: () => '0x' + '02'.repeat(32) },
        messageHash: '0x' + '03'.repeat(32),
        messageLeafIndex: 5n,
      },
      '2026-06-12T00:00:00Z',
    );
    const back = deserializeClaim(s, FakeFr);
    expect(typeof back.claimAmount).toBe('bigint');
    expect(back.claimSecret).toBeTruthy();
    expect(typeof back.messageLeafIndex).toBe('bigint');
  });

  it('claimStorePath: env override wins; default is outside the repo', () => {
    expect(claimStorePath({ FEE_JUICE_CLAIMS_FILE: '/tmp/x.json' } as any)).toBe('/tmp/x.json');
    const def = claimStorePath({} as any);
    expect(def.endsWith('.aztec-triad-private/fee-juice-claims.json')).toBe(true);
    expect(def.includes('aztec-triple-triad')).toBe(false); // must not live inside the repo
  });

  it('claim store: put / get / consume round-trip with 0600 perms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjclaims-'));
    const path = join(dir, 'sub', 'claims.json'); // nested -> exercises mkdir
    try {
      expect(getStoredClaim(loadClaimStore(path), ADDR_A)).toBeUndefined();

      const rec = serializeClaim(
        ADDR_A,
        {
          claimAmount: 9n,
          claimSecret: { toString: () => '0x' + 'aa'.repeat(32) },
          claimSecretHash: { toString: () => '0x' + 'bb'.repeat(32) },
          messageHash: '0x' + 'cc'.repeat(32),
          messageLeafIndex: 1n,
        },
        '2026-06-12T00:00:00Z',
      );
      putStoredClaim(path, ADDR_A, rec);

      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600); // holds claim secrets

      const got = getStoredClaim(loadClaimStore(path), ADDR_A);
      expect(got?.status).toBe('pending');
      expect(got?.claimAmount).toBe('9');

      markClaimConsumed(path, ADDR_A);
      expect(getStoredClaim(loadClaimStore(path), ADDR_A)?.status).toBe('consumed');

      // Distinct addresses don't collide.
      expect(getStoredClaim(loadClaimStore(path), ADDR_B)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('readFunderKey', () => {
    it('returns the TREASURY_L1_KEY env value verbatim', () => {
      const k = '0x' + 'a'.repeat(64);
      expect(readFunderKey({ TREASURY_L1_KEY: k } as any)).toBe(k);
    });

    it('reads a file that is exactly the key', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fk-'));
      try {
        const file = join(dir, 'k.txt');
        const k = '0x' + 'b'.repeat(64);
        writeFileSync(file, k + '\n');
        expect(readFunderKey({ TREASURY_L1_KEY_FILE: file } as any)).toBe(k);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('extracts the key embedded in a labeled / multi-line file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fk-'));
      try {
        const file = join(dir, 'k.txt');
        const k = '0x' + 'c'.repeat(64);
        writeFileSync(file, `Subaccount: treasury demo\nnetwork sepolia\n${k}\n`);
        expect(readFunderKey({ TREASURY_L1_KEY_FILE: file } as any)).toBe(k);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws a clear error when the file holds no 32-byte hex key', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fk-'));
      try {
        const file = join(dir, 'k.txt');
        writeFileSync(file, 'just some words, no key here\n');
        expect(() => readFunderKey({ TREASURY_L1_KEY_FILE: file } as any)).toThrow(/no 0x 32-byte hex/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Live bridge — only with Sepolia creds. Skipped otherwise (like the e2e gate).
  const liveEnabled = !!(process.env.TESTNET_L1_RPC_URL && process.env.TREASURY_L1_KEY);
  it.skipIf(!liveEnabled)('live: bridges to a throwaway L2 address', async () => {
    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    const { bridgeFeeJuice } = await import('./feeJuiceBridge');
    const node = createAztecNodeClient(process.env.AZTEC_PXE_URL || 'https://rpc.testnet.aztec-labs.com');
    const claim = await bridgeFeeJuice({
      node,
      l1RpcUrl: process.env.TESTNET_L1_RPC_URL!,
      funderKey: process.env.TREASURY_L1_KEY!,
      l2Address: ADDR_A,
      log: (m) => console.log('  [bridge]', m),
    });
    expect(claim.claimAmount > 0n).toBe(true);
  });
});
