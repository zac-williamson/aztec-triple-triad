/**
 * The deposit event ABI, pinned against a real log.
 *
 * `to` is indexed. Getting that wrong is invisible everywhere except against a
 * live chain: viem then expects 160 bytes of data where the portal emits 128,
 * and the decode throws AFTER the deposit is mined — the money has moved, and
 * the claim exists only inside the event we just failed to read. A mocked
 * receipt cannot catch it, so this pins the shape to a log the Sepolia portal
 * actually emitted (tx 0xe11b8958…, Fee Juice portal 0xb4a9f8ea…).
 */
import { describe, it, expect } from 'vitest';
import { decodeEventLog, parseAbi, toEventSelector } from 'viem';
import { DEPOSIT_EVENT_ABI } from '../l1Funding';

/** Verbatim from the Sepolia receipt. */
const REAL_LOG = {
  topics: [
    '0xcb43dda0de11e57048e9d074ae7474446335afc906a0e5789d624fa5422629e3',
    '0x0e3c0e29c5de8393bf7e32017841bfc1fb3f76eaeb6f63f4a510f9dd766917c7',
  ],
  data:
    '0x00000000000000000000000000000000000000000000003635c9adc5dea00000' +
    '27aeb1a6e5e903da6398239237dc4ea3d06bda196075fb6ad597b4771d15a651' +
    '00d583d52f5c6e0a06283a5a3af1335f445d49bfd90f2d403e11f11819da3556' +
    '0000000000000000000000000000000000000000000000000000000003814c00',
} as const;

describe('DepositToAztecPublic', () => {
  it('decodes a log the portal really emitted', () => {
    const decoded = decodeEventLog({
      abi: DEPOSIT_EVENT_ABI,
      data: REAL_LOG.data as `0x${string}`,
      topics: REAL_LOG.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
    });
    const args = decoded.args as unknown as {
      to: string; amount: bigint; secretHash: string; key: string; index: bigint;
    };
    expect(decoded.eventName).toBe('DepositToAztecPublic');
    expect(args.to).toBe('0x0e3c0e29c5de8393bf7e32017841bfc1fb3f76eaeb6f63f4a510f9dd766917c7');
    expect(args.amount).toBe(1000000000000000000000n);
    expect(args.secretHash).toBe('0x27aeb1a6e5e903da6398239237dc4ea3d06bda196075fb6ad597b4771d15a651');
    // key and index are the whole point — the claim is unrecoverable without them.
    expect(args.key).toBe('0x00d583d52f5c6e0a06283a5a3af1335f445d49bfd90f2d403e11f11819da3556');
    expect(args.index).toBe(58805248n);
  });

  it('would reject the all-non-indexed spelling that silently broke onboarding', () => {
    const wrong = parseAbi([
      'event DepositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)',
    ]);
    // Same selector, so nothing upstream flags it — it only fails at decode time.
    expect(toEventSelector(wrong[0])).toBe(REAL_LOG.topics[0]);
    expect(() => decodeEventLog({
      abi: wrong,
      data: REAL_LOG.data as `0x${string}`,
      topics: REAL_LOG.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
    })).toThrow(/too small/);
  });
});
