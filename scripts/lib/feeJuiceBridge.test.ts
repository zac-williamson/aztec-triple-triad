/**
 * Unit tests for the Fee Juice bridging helpers.
 *
 *   npx tsx --test scripts/lib/feeJuiceBridge.test.ts
 *
 * Covers the pure logic (arg parsing, claim serialize/deserialize round-trip,
 * claim-store persistence). The live bridge is exercised only when
 * TESTNET_L1_RPC_URL + TREASURY_L1_KEY are set (needs Sepolia), mirroring the
 * integration e2e env-gating — otherwise that test is skipped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parseL2Addresses,
  serializeClaim,
  deserializeClaim,
  claimStorePath,
  putStoredClaim,
  getStoredClaim,
  loadClaimStore,
  markClaimConsumed,
  type FeeJuiceClaim,
} from './feeJuiceBridge';

const ADDR_A = '0x' + '11'.repeat(32);
const ADDR_B = '0x' + 'ab'.repeat(32);

// A tiny Fr stand-in so the pure (de)serialize logic is testable without the SDK.
const FakeFr = { fromHexString: (h: string) => ({ _hex: h, toString: () => h }) };

test('parseL2Addresses: accepts addresses, skips flags', () => {
  assert.deepEqual(parseL2Addresses([ADDR_A, '--mint', ADDR_B]), [ADDR_A, ADDR_B]);
});

test('parseL2Addresses: lowercases', () => {
  assert.deepEqual(parseL2Addresses(['0x' + 'AB'.repeat(32)]), ['0x' + 'ab'.repeat(32)]);
});

test('parseL2Addresses: empty -> empty', () => {
  assert.deepEqual(parseL2Addresses(['--only', '--flags']), []);
});

test('parseL2Addresses: rejects a malformed address loudly', () => {
  assert.throws(() => parseL2Addresses(['0xdeadbeef']), /Not a valid L2 address/);
  assert.throws(() => parseL2Addresses([ADDR_A.slice(0, -2)]), /Not a valid L2 address/);
});

test('serialize/deserialize: round-trips claim shape', () => {
  const claim: FeeJuiceClaim = {
    claimAmount: 1_000_000_000_000n,
    claimSecret: { toString: () => '0x' + '0a'.repeat(32) },
    claimSecretHash: { toString: () => '0x' + '0b'.repeat(32) },
    messageHash: '0x' + 'cd'.repeat(32),
    messageLeafIndex: 42n,
  };
  const s = serializeClaim(ADDR_A, claim, '2026-06-12T00:00:00Z');
  assert.equal(s.status, 'pending');
  assert.equal(s.claimAmount, '1000000000000');
  assert.equal(s.messageLeafIndex, '42');
  assert.equal(s.l2Address, ADDR_A);

  // JSON survives a stringify/parse (it gets persisted as JSON).
  const back = deserializeClaim(JSON.parse(JSON.stringify(s)), FakeFr);
  assert.equal(back.claimAmount, 1_000_000_000_000n);
  assert.equal(back.messageLeafIndex, 42n);
  assert.equal(back.claimSecret.toString(), '0x' + '0a'.repeat(32));
  assert.equal(back.messageHash, '0x' + 'cd'.repeat(32));
});

test('deserialized claim has the fields FeeJuicePaymentMethodWithClaim needs', () => {
  // The SDK constructor wants Pick<L2AmountClaim,'claimAmount'|'claimSecret'|'messageLeafIndex'>.
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
  assert.equal(typeof back.claimAmount, 'bigint');
  assert.ok(back.claimSecret);
  assert.equal(typeof back.messageLeafIndex, 'bigint');
});

test('claimStorePath: env override wins; default is outside the repo', () => {
  assert.equal(claimStorePath({ FEE_JUICE_CLAIMS_FILE: '/tmp/x.json' } as any), '/tmp/x.json');
  const def = claimStorePath({} as any);
  assert.ok(def.endsWith('.aztec-triad-private/fee-juice-claims.json'), def);
  assert.ok(!def.includes('aztec-triple-triad'), 'default must not live inside the repo');
});

test('claim store: put / get / consume round-trip with 0600 perms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fjclaims-'));
  const path = join(dir, 'sub', 'claims.json'); // nested -> exercises mkdir
  try {
    assert.equal(getStoredClaim(loadClaimStore(path), ADDR_A), undefined);

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

    assert.ok(existsSync(path));
    // 0600 — the file holds claim secrets.
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const got = getStoredClaim(loadClaimStore(path), ADDR_A);
    assert.equal(got?.status, 'pending');
    assert.equal(got?.claimAmount, '9');

    markClaimConsumed(path, ADDR_A);
    assert.equal(getStoredClaim(loadClaimStore(path), ADDR_A)?.status, 'consumed');

    // Distinct addresses don't collide.
    assert.equal(getStoredClaim(loadClaimStore(path), ADDR_B), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Live bridge — only with Sepolia creds. Skipped otherwise (like the e2e gate).
const liveEnabled = !!(process.env.TESTNET_L1_RPC_URL && process.env.TREASURY_L1_KEY);
test('live: bridges to a throwaway L2 address', { skip: !liveEnabled }, async () => {
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
  assert.ok(claim.claimAmount > 0n);
});
