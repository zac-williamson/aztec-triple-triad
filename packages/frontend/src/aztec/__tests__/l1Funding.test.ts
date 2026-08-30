/**
 * The wallet-driven funding flow.
 *
 * Driven through a fake EIP-1193 provider, so the whole sequence — chain check,
 * acquire, approve, deposit, event decode — is exercised without a chain. What
 * matters here is the money: not swapping twice, not approving when we already
 * can, not losing the claim when the L1->L2 wait times out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Hex } from 'viem';
import { fundAccountFromWallet, DEPOSIT_EVENT_ABI } from '../l1Funding';

const PORTAL = '0x00000000000000000000000000000000000000aa';
const ASSET = '0x00000000000000000000000000000000000000bb';
const HANDLER = '0x00000000000000000000000000000000000000cc';
const USER = '0x00000000000000000000000000000000000000ee';
const AZTEC_ADDR = `0x${'12'.repeat(32)}`;

// Deliberately the SAME abi the code decodes with. When this file kept its own
// copy, the copy said `to` was non-indexed, the mock encoded that shape, and
// every test passed against a log the real portal never emits — while the live
// decode threw after a real deposit had been made. A fixture that defines its
// own reality cannot fail.

vi.mock('@aztec/aztec.js/ethereum', () => ({
  generateClaimSecret: async () => [
    { toString: () => `0x${'aa'.repeat(32)}` },
    { toString: () => `0x${'bb'.repeat(32)}` },
  ],
}));
vi.mock('@aztec/aztec.js/fields', () => ({
  Fr: { fromHexString: (h: string) => ({ h }) },
}));

/** A receipt carrying a well-formed DepositToAztecPublic log. */
function depositReceipt(secretHash: Hex) {
  const key = `0x${'dd'.repeat(32)}` as Hex;
  const topics = encodeEventTopics({
    abi: DEPOSIT_EVENT_ABI, eventName: 'DepositToAztecPublic',
    args: { to: AZTEC_ADDR as Hex },   // indexed → a topic, not data
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [1000n, secretHash, key, 7n],
  );
  // RPC shape, not viem's decoded shape: status is '0x1'/'0x0' on the wire and
  // viem is what turns it into 'success'. Returning the decoded form made every
  // deposit look reverted.
  return {
    status: '0x1',
    transactionHash: `0x${'11'.repeat(32)}`,
    blockNumber: '0x1',
    blockHash: `0x${'22'.repeat(32)}`,
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    gasUsed: '0x1',
    from: USER,
    to: PORTAL,
    transactionIndex: '0x0',
    type: '0x2',
    logsBloom: `0x${'00'.repeat(256)}`,
    logs: [{
      address: PORTAL, topics, data,
      blockNumber: '0x1', blockHash: `0x${'22'.repeat(32)}`,
      transactionHash: `0x${'11'.repeat(32)}`, transactionIndex: '0x0',
      logIndex: '0x0', removed: false,
    }],
  };
}

interface FakeOpts { balance?: bigint; allowance?: bigint; chainId?: number }

function installWallet(opts: FakeOpts = {}) {
  const sent: string[] = [];
  let balance = opts.balance ?? 0n;
  const allowance = opts.allowance ?? 0n;

  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case 'eth_chainId': return `0x${(opts.chainId ?? 11155111).toString(16)}`;
        case 'eth_requestAccounts': return [USER];
        case 'wallet_switchEthereumChain': return null;
        case 'eth_call': {
          const to = (params?.[0] as { to: string; data: string }).to.toLowerCase();
          const data = (params?.[0] as { data: string }).data;
          // mintAmount() / balanceOf() / allowance() — selector-free stubs are
          // fine because each address is only asked one kind of question.
          if (to === HANDLER.toLowerCase()) return `0x${(1000n).toString(16).padStart(64, '0')}`;
          if (to === ASSET.toLowerCase()) {
            if (data.startsWith('0xdd62ed3e')) return `0x${allowance.toString(16).padStart(64, '0')}`;
            return `0x${balance.toString(16).padStart(64, '0')}`;
          }
          return '0x';
        }
        case 'eth_sendTransaction': {
          const to = (params?.[0] as { to: string }).to.toLowerCase();
          sent.push(to);
          if (to === HANDLER.toLowerCase()) balance = 1000n;   // the mint lands
          return `0x${'11'.repeat(32)}`;
        }
        case 'eth_getTransactionReceipt':
          return depositReceipt(`0x${'bb'.repeat(32)}`);
        case 'eth_blockNumber': return '0x1';
        case 'eth_getBlockByNumber': return { number: '0x1', hash: `0x${'00'.repeat(32)}`, transactions: [] };
        default: return null;
      }
    },
  };
  (globalThis as { ethereum?: unknown }).ethereum = provider;
  return { sent };
}

const node = { getL1ToL2MessageMembershipWitness: async () => ({ ok: true }) };
const l1 = { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL, feeAssetHandlerAddress: HANDLER } as never;

afterEach(() => { delete (globalThis as { ethereum?: unknown }).ethereum; });

describe('fundAccountFromWallet', () => {
  it('refuses to start when there is no wallet', async () => {
    delete (globalThis as { ethereum?: unknown }).ethereum;
    await expect(fundAccountFromWallet({
      aztecAddress: AZTEC_ADDR, l1, chainId: 11155111, node, route: { kind: 'mint' },
    } as never)).rejects.toThrow(/No Ethereum wallet/i);
  });

  it('does not mint again when the player already holds the fee asset', async () => {
    const { sent } = installWallet({ balance: 5000n });
    await fundAccountFromWallet({
      aztecAddress: AZTEC_ADDR, l1, chainId: 11155111, node, route: { kind: 'mint' }, messageWaitSeconds: 2,
    } as never);
    // Spending twice because a retry re-ran the flow is exactly the bug this
    // balance check exists to prevent.
    expect(sent).not.toContain(HANDLER.toLowerCase());
  });

  it('skips the approval when the allowance already covers it', async () => {
    const { sent } = installWallet({ balance: 5000n, allowance: 10_000n });
    await fundAccountFromWallet({
      aztecAddress: AZTEC_ADDR, l1, chainId: 11155111, node, route: { kind: 'mint' }, messageWaitSeconds: 2,
    } as never);
    expect(sent.filter(a => a === ASSET.toLowerCase())).toHaveLength(0);
    expect(sent).toContain(PORTAL.toLowerCase());
  });

  it('returns a claim carrying the message key and leaf index from the event', async () => {
    installWallet({ balance: 5000n, allowance: 10_000n });
    const claim = await fundAccountFromWallet({
      aztecAddress: AZTEC_ADDR, l1, chainId: 11155111, node, route: { kind: 'mint' }, messageWaitSeconds: 2,
    } as never);
    // A receipt carries no return data, so these MUST come from the log.
    expect(claim.messageHash).toBe(`0x${'dd'.repeat(32)}`);
    expect(claim.messageLeafIndex).toBe(7n);
    expect(claim.claimAmount).toBe(5000n);
  });

  it('hands the claim back even when the L1->L2 wait times out', async () => {
    installWallet({ balance: 5000n, allowance: 10_000n });
    const neverArrives = { getL1ToL2MessageMembershipWitness: async () => null };
    const err = await fundAccountFromWallet({
      aztecAddress: AZTEC_ADDR, l1, chainId: 11155111, node: neverArrives,
      route: { kind: 'mint' }, messageWaitSeconds: 1,
    } as never).catch(e => e);
    // The deposit is irreversible by this point. Dropping the claim would
    // strand the player's money with no way to recover it.
    expect(err.message).toMatch(/funds are safe/i);
    expect(err.claim?.messageLeafIndex).toBe(7n);
  });

  it('reports progress so the wait can be explained rather than spun', async () => {
    installWallet({ balance: 5000n, allowance: 10_000n });
    const steps: string[] = [];
    await fundAccountFromWallet({
      aztecAddress: AZTEC_ADDR, l1, chainId: 11155111, node, route: { kind: 'mint' },
      messageWaitSeconds: 2, onProgress: (p: { step: string }) => steps.push(p.step),
    } as never);
    expect(steps).toContain('deposit');
    expect(steps).toContain('await-message');
    expect(steps[steps.length - 1]).toBe('done');
  });
});
