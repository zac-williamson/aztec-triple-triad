/**
 * bridgeFeeJuice must make the portal allowance VISIBLE on the L1 RPC before it
 * hands over to the SDK's bridgeTokensPublic.
 *
 * v6's bridgeTokensPublic approves and then immediately pre-flights the deposit
 * with an eth_call. On a load-balanced public RPC that call can land on a
 * backend a block behind the approve's receipt and revert
 * ERC20InsufficientAllowance although the approve is mined — which is how the
 * first v6 testnet deploy died (20 Nov 2026). The SDK is mocked here; the
 * live bridge is covered by the env-gated test in feeJuiceBridge.test.ts.
 *
 *   npx vitest run scripts/lib/feeJuiceBridge.allowance.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TARGET = 1000n * 10n ** 18n;
const PORTAL = '0x' + 'e5'.repeat(20);
const TOKEN = '0x' + '76'.repeat(20);
const FUNDER = '0x' + 'da'.repeat(20);
const L2 = '0x' + '16'.repeat(32);

const events: string[] = [];
let allowanceOnRpc = 0n;
/** Reads the RPC serves stale (pre-approve) state for, after the approve lands. */
let laggingReads = 0;

const tokenManager = {
  tokenAddress: { toString: () => TOKEN },
  getMintAmount: vi.fn(async () => TARGET),
  getL1TokenBalance: vi.fn(async () => TARGET),
  mint: vi.fn(async () => {}),
  approve: vi.fn(async (amount: bigint, spender: string) => {
    events.push(`approve:${spender}`);
    allowanceOnRpc = amount;
  }),
};

const portalManager = {
  getTokenManager: () => tokenManager,
  bridgeTokensPublic: vi.fn(async () => {
    events.push('bridge');
    return {
      claimAmount: TARGET,
      claimSecret: { toString: () => '0x' + '01'.repeat(32) },
      claimSecretHash: { toString: () => '0x' + '02'.repeat(32) },
      messageHash: '0x' + '03'.repeat(32),
      messageLeafIndex: 7n,
    };
  }),
};

const l1Client = {
  account: { address: FUNDER },
  readContract: vi.fn(async (req: { functionName: string; args: string[] }) => {
    expect(req.functionName).toBe('allowance');
    expect(req.args).toEqual([FUNDER, PORTAL]);
    const seen = events.some((e) => e.startsWith('approve')) && laggingReads-- > 0 ? 0n : allowanceOnRpc;
    events.push(`read:${seen === TARGET ? 'visible' : 'zero'}`);
    return seen;
  }),
};

vi.mock('@aztec-labs/aztec.js/ethereum', () => ({
  L1FeeJuicePortalManager: { new: vi.fn(async () => portalManager) },
}));
vi.mock('@aztec-labs/ethereum/client', () => ({
  createExtendedL1Client: vi.fn(() => l1Client),
}));

const node = {
  getNodeInfo: vi.fn(async () => ({
    l1ContractAddresses: { feeJuicePortalAddress: { toString: () => PORTAL } },
  })),
  getL1ToL2MessageMembershipWitness: vi.fn(async () => [7n, {}]),
};

async function bridge() {
  const { bridgeFeeJuice } = await import('./feeJuiceBridge');
  return bridgeFeeJuice({
    node,
    l1RpcUrl: 'https://l1.invalid',
    funderKey: '0x' + 'aa'.repeat(32),
    l2Address: L2,
    log: () => {},
  });
}

describe('bridgeFeeJuice portal allowance', () => {
  beforeEach(() => {
    events.length = 0;
    allowanceOnRpc = 0n;
    laggingReads = 0;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ result: '0xaa36a7' }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('approves the portal and waits for the allowance to be visible before bridging', async () => {
    laggingReads = 1; // the first read after the approve comes from a stale backend
    const claim = await bridge();

    expect(tokenManager.approve).toHaveBeenCalledTimes(1);
    expect(tokenManager.approve).toHaveBeenCalledWith(TARGET, PORTAL, 'FeeJuice Portal');
    expect(events).toEqual([
      'read:zero',
      `approve:${PORTAL}`,
      'read:zero',
      'read:visible',
      'bridge',
    ]);
    expect(claim.claimAmount).toBe(TARGET);
  });

  it('skips the approve when the allowance is already in place', async () => {
    allowanceOnRpc = TARGET;
    await bridge();

    expect(tokenManager.approve).not.toHaveBeenCalled();
    expect(events).toEqual(['read:visible', 'bridge']);
  });
});
