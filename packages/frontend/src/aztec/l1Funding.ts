/**
 * Fund a new Aztec account from the player's own wallet, in the browser.
 *
 * This is the MAINNET path. Fee Juice is non-transferable on L2 — no account can
 * send it to another — so the only way to fund one is to deposit the fee asset
 * into the Fee Juice portal on L1 and have the account CLAIM the resulting
 * L1->L2 message in its first transaction. Three L1 calls, all signable by
 * MetaMask:
 *
 *   1. acquire the fee asset  (swap ETH for it, or mint it where that is free)
 *   2. approve(portal, amount)
 *   3. depositToAztecPublic(aztecAddress, amount, secretHash)
 *
 * Step 1 is the only one that differs between networks, and it is deliberately
 * the ONLY difference: on mainnet the player swaps ETH through a DEX, on a
 * testnet the fee asset is a mock with a free permissionless mint. Steps 2 and 3
 * are byte-identical either way, so a testnet run exercises the real mainnet
 * code for everything but the swap.
 *
 * The swap itself is covered separately, because "the only leg that spends real
 * money" and "the only leg no deployment exercises" must not be the same leg:
 * packages/playtest/scripts/swap-leg-live.mts runs swapForFeeAsset against a
 * real Uniswap V3 pool on Sepolia.
 *
 * We do NOT reuse the SDK's L1FeeJuicePortalManager here: it requires an HTTP
 * transport and a local private-key account (see createExtendedL1Client), and
 * the whole point is to sign with the player's wallet instead of a key we hold.
 */
import {
  createPublicClient, createWalletClient, custom, http,
  encodeFunctionData, encodeAbiParameters, concatHex, numberToHex,
  parseAbi, decodeEventLog, formatEther,
  type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { NATIVE, type PoolKey } from './uniswapQuote';

/** The subset of the portal/ERC20/handler ABIs this flow touches. */
/** Exported so a test can pin it against a log the real portal emitted. */
export const DEPOSIT_EVENT_ABI = parseAbi([
  // `to` is INDEXED. Declaring it as data made viem expect 160 bytes where the
  // real log carries 128, so the decode threw AFTER the deposit was mined —
  // the worst place to fail, since the money has moved and the claim is only
  // recoverable from this event.
  'event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)',
]);

const PORTAL_ABI = parseAbi([
  'function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash) returns (bytes32, uint256)',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);
const FEE_ASSET_HANDLER_ABI = parseAbi([
  'function mint(address _recipient)',
  'function mintAmount() view returns (uint256)',
]);
/**
 * Uniswap Universal Router. v4 swaps go through it as an encoded command rather
 * than a direct call: one V4_SWAP command whose payload is a little action
 * program the router replays against the PoolManager.
 */
const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

/** UniversalRouter command. */
const CMD_V4_SWAP = 0x10;
/**
 * v4-periphery action opcodes (Actions.sol). Three are needed for one swap:
 * do the trade, pay what we owe, collect what we are owed. Getting any of them
 * wrong reverts the whole transaction rather than misbehaving quietly, and the
 * fork test in packages/playtest/scripts/ exercises exactly this encoding
 * against the real router and the real pool.
 */
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

/** L1 addresses, as the Aztec node reports them. */
export interface L1Addresses {
  feeJuiceAddress: Address;
  feeJuicePortalAddress: Address;
  /** Present only where the fee asset is a mock with a free mint (testnets). */
  feeAssetHandlerAddress?: Address;
}

/**
 * How to obtain the fee asset on a given chain.
 *
 * `mint` is a testnet convenience. `swap` is the real path: the player pays with
 * their own ETH, which is what makes this work on mainnet without us subsidising
 * anyone.
 */
export type AcquireRoute =
  | { kind: 'mint' }
  | {
      kind: 'swap';
      /** Uniswap Universal Router. v4 has no per-pool router entry point. */
      router: Address;
      /** The exact pool to trade in. v4 identifies pools by the whole key. */
      poolKey: PoolKey;
      /** Direction through the pool, derived from which currency we spend. */
      zeroForOne: boolean;
      /** Chain-native ETH to spend. The swap is exact-input: we spend this much. */
      ethIn: bigint;
      /**
       * Expected fee-asset output for `ethIn`, from the router's quoter.
       * Required: see quoteFloor — a swap without a minimum can be sandwiched
       * for its full value, and a spot price read on-chain is the very thing an
       * attacker manipulates.
       */
      quotedOut: bigint;
      /**
       * Slippage floor, as a fraction (0.02 = accept 2% worse than quoted).
       * A swap with no floor can be sandwiched for everything it is worth.
       */
      maxSlippage: number;
      /** How long the router will accept this transaction. */
      deadlineSeconds?: number;
    };

export interface FundingProgress {
  step: 'connect' | 'acquire' | 'approve' | 'deposit' | 'await-message' | 'done';
  detail: string;
}

/** What the account deployment needs to claim the bridged Fee Juice. */
export interface BridgedClaim {
  claimAmount: bigint;
  claimSecret: unknown;
  claimSecretHash: unknown;
  messageHash: Hex;
  messageLeafIndex: bigint;
}

export interface FundAccountParams {
  /** The Aztec address being funded, as a 0x field string. */
  aztecAddress: string;
  l1: L1Addresses;
  /** Chain the L1 contracts live on. MetaMask is asked to switch if needed. */
  chainId: number;
  /** An Aztec node client, used to wait for the L1->L2 message. */
  node: { getL1ToL2MessageMembershipWitness: (b: string, h: unknown) => Promise<unknown> };
  route: AcquireRoute;
  /** How long to wait for the message to land in the L2 tree. */
  messageWaitSeconds?: number;
  onProgress?: (p: FundingProgress) => void;
}

const eip1193 = (): { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } => {
  const eth = (globalThis as { ethereum?: unknown }).ethereum as
    | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
    | undefined;
  if (!eth) {
    throw new Error('No Ethereum wallet found. Install MetaMask, or fund the account another way.');
  }
  return eth;
};

/**
 * Ask the wallet for the right chain, adding it if unknown.
 *
 * Signing on the wrong chain produces a transaction that succeeds against the
 * wrong contracts — worse than a failure, because the player's money is gone and
 * nothing tells them why.
 */
async function ensureChain(provider: ReturnType<typeof eip1193>, chainId: number): Promise<void> {
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) === chainId) return;
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${chainId.toString(16)}` }],
  });
}

/** Wait for a receipt, failing loudly on revert rather than continuing. */
async function mined(pub: PublicClient, hash: Hex, what: string) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${what} reverted on L1 (${hash})`);
  return receipt;
}

/**
 * Fund an Aztec account from the connected wallet and return the claim.
 *
 * Every step is idempotent-ish on purpose: the balance and allowance are checked
 * before spending, so a retry after a wallet rejection does not buy the fee asset
 * twice.
 */
export async function fundAccountFromWallet(params: FundAccountParams): Promise<BridgedClaim> {
  const { aztecAddress, l1, chainId, node, route } = params;
  const report = (step: FundingProgress['step'], detail: string) =>
    params.onProgress?.({ step, detail });

  report('connect', 'Connecting your wallet…');
  const provider = eip1193();
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const account = accounts?.[0];
  if (!account) throw new Error('Wallet returned no account');
  await ensureChain(provider, chainId);

  const transport = custom(provider);
  const pub = createPublicClient({ transport }) as PublicClient;
  const wallet = createWalletClient({ account, transport }) as WalletClient;

  const feeAsset = l1.feeJuiceAddress;
  const portal = l1.feeJuicePortalAddress;

  // ---- 1. Acquire the fee asset -------------------------------------------
  let amount: bigint;
  if (route.kind === 'mint') {
    if (!l1.feeAssetHandlerAddress) {
      throw new Error('This network has no fee-asset faucet; a swap route must be configured.');
    }
    const mintAmount = await pub.readContract({
      address: l1.feeAssetHandlerAddress, abi: FEE_ASSET_HANDLER_ABI, functionName: 'mintAmount',
    });
    const held = await pub.readContract({
      address: feeAsset, abi: ERC20_ABI, functionName: 'balanceOf', args: [account],
    });
    if (held < mintAmount) {
      report('acquire', 'Claiming test Fee Juice…');
      const hash = await wallet.sendTransaction({
        account, chain: null, to: l1.feeAssetHandlerAddress,
        data: encodeFunctionData({ abi: FEE_ASSET_HANDLER_ABI, functionName: 'mint', args: [account] }),
      });
      await mined(pub, hash, 'Fee asset mint');
      amount = mintAmount;
    } else {
      // Already holds enough from an earlier attempt — do not mint again.
      amount = held < mintAmount ? mintAmount : held;
    }
  } else {
    report('acquire', `Swapping ${formatEther(route.ethIn)} ETH for Fee Juice…`);
    amount = await swapForFeeAsset({ pub, wallet, account, feeAsset, route });
  }

  // ---- 2. Approve the portal ----------------------------------------------
  const allowance = await pub.readContract({
    address: feeAsset, abi: ERC20_ABI, functionName: 'allowance', args: [account, portal],
  });
  if (allowance < amount) {
    report('approve', 'Approving the Fee Juice bridge…');
    const hash = await wallet.sendTransaction({
      account, chain: null, to: feeAsset,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [portal, amount] }),
    });
    await mined(pub, hash, 'Approve');
  }

  // ---- 3. Deposit to the portal -------------------------------------------
  report('deposit', 'Bridging to your Aztec account…');
  const { generateClaimSecret } = await import('@aztec/aztec.js/ethereum');
  const [claimSecret, claimSecretHash] = await generateClaimSecret();

  const depositHash = await wallet.sendTransaction({
    account, chain: null, to: portal,
    data: encodeFunctionData({
      abi: PORTAL_ABI,
      functionName: 'depositToAztecPublic',
      args: [aztecAddress as Hex, amount, claimSecretHash.toString() as Hex],
    }),
  });
  const receipt = await mined(pub, depositHash, 'Bridge deposit');

  // The message key and leaf index come from the event, not the return value —
  // a transaction's return data is not available from a receipt.
  const wanted = claimSecretHash.toString().toLowerCase();
  let key: Hex | null = null;
  let index: bigint | null = null;
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== portal.toLowerCase()) continue;
    try {
      const parsed = decodeEventLog({ abi: DEPOSIT_EVENT_ABI, data: logEntry.data, topics: logEntry.topics });
      if (parsed.eventName !== 'DepositToAztecPublic') continue;
      const a = parsed.args as unknown as { secretHash: Hex; key: Hex; index: bigint };
      if (a.secretHash.toLowerCase() !== wanted) continue;
      key = a.key;
      index = a.index;
      break;
    } catch { /* not our event */ }
  }
  if (key === null || index === null) {
    // Name what was actually there. This failure costs a real deposit, so the
    // next person to hit it should not need a second run to see why.
    const seen = receipt.logs
      .filter(l => l.address.toLowerCase() === portal.toLowerCase())
      .map(l => `${l.topics[0]} (${l.topics.length} topics, ${(l.data.length - 2) / 2}B)`)
      .join('; ') || 'none';
    throw new Error(
      `Bridge deposit ${depositHash} was mined but no DepositToAztecPublic event matched ` +
      `secret hash ${wanted}. Portal logs seen: ${seen}. The deposit is on-chain — the ` +
      `claim can still be recovered from that transaction.`,
    );
  }

  // ---- 4. Wait for the message to reach L2 --------------------------------
  // This is the dominant latency of the whole flow. The deposit is already
  // irreversible at this point, so the claim must be handed back even if the
  // wait times out — losing it would strand the player's money.
  report('await-message', 'Waiting for Ethereum to reach Aztec…');
  const claim: BridgedClaim = {
    claimAmount: amount,
    claimSecret,
    claimSecretHash,
    messageHash: key,
    messageLeafIndex: index,
  };

  const { Fr } = await import('@aztec/aztec.js/fields');
  const waitSeconds = params.messageWaitSeconds ?? 900;
  const messageHash = Fr.fromHexString(key);
  for (let i = 0; i < waitSeconds; i++) {
    try {
      if (await node.getL1ToL2MessageMembershipWitness('latest', messageHash)) {
        report('done', 'Your account is funded.');
        return claim;
      }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Object.assign(
    new Error(
      `The bridge transaction is confirmed on Ethereum but has not reached Aztec within ` +
      `${waitSeconds}s. Your funds are safe — reopen the game to finish claiming them.`,
    ),
    { claim },
  );
}

/**
 * Buy the fee asset on a DEX and return how much actually arrived.
 *
 * Split out of the funding flow so it can be run against a real pool: on a
 * network whose fee asset is a mock this branch never executes, which would
 * otherwise leave the one leg that spends real money as the one leg no test
 * ever runs.
 *
 * The amount is measured as a balance delta rather than taken from the router's
 * return value, because a fee-on-transfer or rebasing token can deliver less
 * than it reports, and the deposit that follows must bridge what we HAVE.
 */
export async function swapForFeeAsset(params: {
  pub: PublicClient;
  wallet: WalletClient;
  account: Address;
  feeAsset: Address;
  route: Extract<AcquireRoute, { kind: 'swap' }>;
}): Promise<bigint> {
  const { pub, wallet, account, feeAsset, route } = params;
  const before = await pub.readContract({
    address: feeAsset, abi: ERC20_ABI, functionName: 'balanceOf', args: [account],
  });

  const minOut = quoteFloor(route);
  const currencyIn = route.zeroForOne ? route.poolKey.currency0 : route.poolKey.currency1;
  const currencyOut = route.zeroForOne ? route.poolKey.currency1 : route.poolKey.currency0;

  // One V4_SWAP command carrying a three-step action program: trade, pay in,
  // take out. SETTLE_ALL and TAKE_ALL both carry a bound, so the router itself
  // refuses to spend more or deliver less than we agreed.
  const actions = concatHex([
    numberToHex(ACTION_SWAP_EXACT_IN_SINGLE, { size: 1 }),
    numberToHex(ACTION_SETTLE_ALL, { size: 1 }),
    numberToHex(ACTION_TAKE_ALL, { size: 1 }),
  ]);
  const swapParams = encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'poolKey', type: 'tuple', components: [
          { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ] },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    [{
      poolKey: route.poolKey,
      zeroForOne: route.zeroForOne,
      amountIn: route.ethIn,
      amountOutMinimum: minOut,
      hookData: '0x',
    }] as never,
  );
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }], [currencyIn, route.ethIn],
  );
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }], [currencyOut, minOut],
  );
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settleParams, takeParams]],
  );

  const hash = await wallet.sendTransaction({
    account, chain: null, to: route.router,
    // Native ETH in: the value IS the input, so there is nothing to approve.
    value: currencyIn === NATIVE ? route.ethIn : 0n,
    data: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [
        numberToHex(CMD_V4_SWAP, { size: 1 }),
        [v4Input],
        BigInt(Math.floor(Date.now() / 1000) + (route.deadlineSeconds ?? 600)),
      ],
    }),
  });
  await mined(pub, hash, 'Fee asset swap');
  const after = await pub.readContract({
    address: feeAsset, abi: ERC20_ABI, functionName: 'balanceOf', args: [account],
  });
  const gained = after - before;
  if (gained <= 0n) {
    throw new Error('Swap completed but no Fee Juice arrived — check the pool key and liquidity.');
  }
  return gained;
}

/**
 * The minimum acceptable swap output.
 *
 * Refusing to swap without a caller-supplied quote is deliberate: `0` would let
 * anyone watching the mempool sandwich the trade and take the whole amount, and
 * an amount computed from an on-chain spot price is exactly what a sandwich
 * manipulates. The quote belongs upstream, from the router's quoter.
 */
function quoteFloor(route: Extract<AcquireRoute, { kind: 'swap' }>): bigint {
  const quoted = route.quotedOut;
  if (quoted === undefined || quoted <= 0n) {
    throw new Error(
      'Refusing to swap without a quote: a swap with no minimum output can be ' +
      'sandwiched for its full value. Fetch a quote and pass quotedOut.',
    );
  }
  const bps = BigInt(Math.round((1 - route.maxSlippage) * 10_000));
  return (quoted * bps) / 10_000n;
}
