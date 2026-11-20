/**
 * What bridgeFeeJuice sends to L1. viem's client and the SDK's claim-secret
 * helper are mocked; the contract ABIs and encodings are real. The live bridge
 * is covered by the env-gated test in feeJuiceBridge.test.ts.
 *
 *   npx vitest run scripts/lib/feeJuiceBridge.flow.test.ts
 *
 * The properties that matter: a bridge is ONE L1 transaction, in the steady
 * state the cheapest there is (a plain deposit from the funder's float), and no
 * transaction depends on another one sent moments earlier — the dependency
 * that made 2 of 7 testnet bridges revert ERC20InsufficientAllowance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, multicall3Abi } from 'viem';
import { FeeAssetHandlerAbi, FeeJuicePortalAbi, TestERC20Abi } from '@aztec-foundation/l1-artifacts';

const FJ = 10n ** 18n;
const MINT = 1000n * FJ;
const MAX = 2n ** 256n - 1n;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const HANDLER = '0x' + '56'.repeat(20);
const TOKEN = '0x' + '76'.repeat(20);
const PORTAL = '0x' + 'e5'.repeat(20);
const FUNDER = '0x' + 'da'.repeat(20);
const L2 = '0x' + '16'.repeat(32);
const SECRET_HASH = '0x' + '02'.repeat(32);
const KEY = '0x00' + 'ab'.repeat(31);

const state = { float: 0n, allowance: 0n, status: 'success' as 'success' | 'reverted', emitDeposit: true };
const writes: { address: string; functionName: string; args: any[] }[] = [];
let lastAmount = 0n;

function depositLog(amount: bigint) {
  const event = (FeeJuicePortalAbi as readonly any[]).find((x) => x.type === 'event' && x.name === 'DepositToAztecPublic');
  return {
    address: PORTAL,
    topics: encodeEventTopics({ abi: FeeJuicePortalAbi, eventName: 'DepositToAztecPublic', args: { to: L2 } } as any),
    data: encodeAbiParameters(event.inputs.filter((i: any) => !i.indexed), [amount, SECRET_HASH, KEY, 7n]),
    blockNumber: 1n,
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: '0x' + '0f'.repeat(32),
    blockHash: '0x' + '0e'.repeat(32),
    removed: false,
  };
}

const client = {
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'balanceOf') return state.float;
    if (functionName === 'allowance') return state.allowance;
    if (functionName === 'mintAmount') return MINT;
    throw new Error(`unexpected read ${functionName}`);
  }),
  estimateContractGas: vi.fn(async () => 100_000n),
  writeContract: vi.fn(async (req: { address: string; functionName: string; args: any[] }) => {
    writes.push({ address: req.address, functionName: req.functionName, args: req.args });
    return `0x${String(writes.length).padStart(64, '0')}`;
  }),
  waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
    const w = writes[Number(BigInt(hash)) - 1];
    const isApprove = w.functionName === 'approve';
    return {
      status: isApprove ? 'success' : state.status,
      blockNumber: 1n,
      gasUsed: isApprove ? 46_000n : 290_000n,
      logs: !isApprove && state.emitDeposit ? [depositLog(lastAmount)] : [],
    };
  }),
};

vi.mock('viem', async (importOriginal) => {
  const real = await importOriginal<typeof import('viem')>();
  return { ...real, createWalletClient: () => ({ extend: () => client }) };
});
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: FUNDER }),
  nonceManager: {},
}));
vi.mock('@aztec-labs/aztec.js/ethereum', () => ({
  generateClaimSecret: async () => [{ toString: () => '0x' + '01'.repeat(32) }, { toString: () => SECRET_HASH }],
}));

const node = {
  getNodeInfo: vi.fn(async () => ({
    l1ContractAddresses: {
      feeAssetHandlerAddress: { toString: () => HANDLER },
      feeJuiceAddress: { toString: () => TOKEN },
      feeJuicePortalAddress: { toString: () => PORTAL },
    },
  })),
  getL1ToL2MessageMembershipWitness: vi.fn(async () => [7n, {}]),
};

async function bridge(amount?: bigint) {
  lastAmount = amount ?? 100n * FJ;
  const { bridgeFeeJuice } = await import('./feeJuiceBridge');
  return bridgeFeeJuice({
    node,
    l1RpcUrl: 'https://l1.invalid',
    funderKey: '0x' + 'aa'.repeat(32),
    l2Address: L2,
    log: () => {},
    amount,
  });
}

/** The calls inside one aggregate3, decoded against the contract they target. */
function batch(w: { args: any[] }) {
  const abiFor: Record<string, any> = { [HANDLER]: FeeAssetHandlerAbi, [TOKEN]: TestERC20Abi, [PORTAL]: FeeJuicePortalAbi };
  return (w.args[0] as { target: string; callData: `0x${string}` }[]).map(({ target, callData }) => {
    const { functionName, args } = decodeFunctionData({ abi: abiFor[target], data: callData });
    // viem decodes addresses checksummed; compare them lower-case.
    const plain = (a: unknown) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);
    return [target, functionName, ...(args ?? []).map(plain)];
  });
}

describe('bridgeFeeJuice', () => {
  beforeEach(() => {
    Object.assign(state, { float: 0n, allowance: 0n, status: 'success', emitDeposit: true });
    writes.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ result: '0xaa36a7' }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is one plain deposit when the funder holds a float under its standing allowance', async () => {
    Object.assign(state, { float: 900n * FJ, allowance: MAX });
    const claim = await bridge();

    expect(writes).toEqual([
      { address: PORTAL, functionName: 'depositToAztecPublic', args: [L2, 100n * FJ, SECRET_HASH] },
    ]);
    expect(claim).toMatchObject({ claimAmount: 100n * FJ, messageHash: KEY, messageLeafIndex: 7n });
  });

  it('cold-starts in ONE transaction: mint, approve, deposit and park the rest, then grants the allowance once', async () => {
    const claim = await bridge();

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ address: MULTICALL3, functionName: 'aggregate3' });
    expect(batch(writes[0])).toEqual([
      [HANDLER, 'mint', MULTICALL3.toLowerCase()],
      [TOKEN, 'approve', PORTAL, 100n * FJ],
      [PORTAL, 'depositToAztecPublic', L2, 100n * FJ, SECRET_HASH],
      [TOKEN, 'transfer', FUNDER, 900n * FJ],
    ]);
    expect(writes[1]).toEqual({ address: TOKEN, functionName: 'approve', args: [PORTAL, MAX] });
    expect(claim.messageHash).toBe(KEY);
  });

  it('does not grant the allowance again once it stands', async () => {
    Object.assign(state, { float: 50n * FJ, allowance: MAX }); // float too small for this bridge
    await bridge();

    expect(writes.map((w) => w.functionName)).toEqual(['aggregate3']);
  });

  it('parks nothing when the bridge takes the whole mint', async () => {
    state.allowance = MAX;
    await bridge(MINT);

    expect(batch(writes[0]).map((c) => c[1])).toEqual(['mint', 'approve', 'depositToAztecPublic']);
  });

  it('throws on a reverted bridge transaction, before waiting on L2', async () => {
    Object.assign(state, { float: 900n * FJ, allowance: MAX, status: 'reverted' });
    await expect(bridge()).rejects.toThrow(/reverted on L1/);
    expect(node.getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
  });

  it('throws when the receipt carries no deposit for our secret hash', async () => {
    Object.assign(state, { float: 900n * FJ, allowance: MAX, emitDeposit: false });
    await expect(bridge()).rejects.toThrow(/no DepositToAztecPublic/);
  });
});
