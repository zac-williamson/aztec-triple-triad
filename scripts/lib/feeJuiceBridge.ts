/**
 * Fee Juice bridging core (L1 -> L2), shared by the funding + deploy scripts.
 *
 * Fee Juice is NON-TRANSFERABLE on L2: an account cannot send it to another
 * account. The ONLY way to fund an account is to bridge from L1 through the
 * Fee Juice portal and have the account *claim* the resulting L1->L2 message
 * in a transaction (FeeJuicePaymentMethodWithClaim). This module
 * generalizes the proven local-devnet flow (packages/frontend/src/aztec/
 * fundDevnet.ts) to any network by taking the L1 RPC URL + an L1 funder key
 * from the caller instead of hardcoding Anvil's mnemonic.
 *
 * SHARING / DEDUP (flagged for the orchestrator): fundDevnet.ts (Lane 2) still
 * contains a near-identical local-only copy of bridgeFeeJuice's core. It should
 * eventually be refactored to import from here, but that edits a Lane 2 file, so
 * it is flagged rather than done. The canonical long-term home for this module
 * is a shared workspace package (proposal: packages/aztec-fee/) so the frontend
 * funding path (item I) and the headless bot (D2) can depend on it without
 * reaching into scripts/ or each other's src/. It lives under scripts/lib/ for
 * now because that is the orchestrator-sanctioned area for the deploy/fund
 * tooling and keeps the two scripts deduplicated today.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A bridged Fee Juice claim, in runtime form (Fr fields, bigints). */
export interface FeeJuiceClaim {
  /** Amount of Fee Juice bridged, claimable on L2. */
  claimAmount: bigint;
  /** Secret that authorizes the claim (Fr). */
  claimSecret: any;
  /** Hash of the claim secret (Fr). */
  claimSecretHash: any;
  /** Hash of the L1->L2 message (hex). */
  messageHash: string;
  /** Leaf index of the message in the L1->L2 message tree. */
  messageLeafIndex: bigint;
}

/** A persisted claim record: all fields JSON-safe, plus bookkeeping. */
export interface SerializedClaim {
  l2Address: string;
  claimAmount: string;
  claimSecret: string;
  claimSecretHash: string;
  messageHash: string;
  messageLeafIndex: string;
  /** 'pending' until the consuming tx (account deploy) lands, then 'consumed'. */
  status: 'pending' | 'consumed';
  /** ISO timestamp the claim was bridged (caller-supplied; Date is fine here). */
  bridgedAt: string;
}

/** On-disk shape: a map of L2 address -> its latest claim. */
export type ClaimStore = Record<string, SerializedClaim>;

export type LogFn = (msg: string) => void;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no network, no SDK)
// ---------------------------------------------------------------------------

/**
 * Parse L2 account addresses from a CLI argv tail. Accepts any number of
 * 0x-prefixed 64-hex-char Aztec addresses; ignores flags (--foo) and anything
 * that is not address-shaped. Throws if a flag-free token is present but is not
 * a valid address, so typos surface loudly instead of being silently skipped.
 */
export function parseL2Addresses(args: string[]): string[] {
  const addrRe = /^0x[0-9a-fA-F]{64}$/;
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith('--')) continue;
    if (addrRe.test(a)) {
      out.push(a.toLowerCase());
    } else {
      throw new Error(`Not a valid L2 address (expected 0x + 64 hex chars): ${a}`);
    }
  }
  return out;
}

/** Parse an `eth_chainId` JSON-RPC hex result (e.g. "0xaa36a7") to a number. */
export function parseChainIdHex(hex: string): number {
  const n = Number.parseInt(hex, 16);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid eth_chainId result: ${hex}`);
  return n;
}

/** Serialize a runtime claim for persistence. */
export function serializeClaim(
  l2Address: string,
  claim: FeeJuiceClaim,
  bridgedAt: string,
  status: SerializedClaim['status'] = 'pending',
): SerializedClaim {
  return {
    l2Address: l2Address.toLowerCase(),
    claimAmount: claim.claimAmount.toString(),
    claimSecret: claim.claimSecret.toString(),
    claimSecretHash: claim.claimSecretHash.toString(),
    messageHash: claim.messageHash,
    messageLeafIndex: claim.messageLeafIndex.toString(),
    status,
    bridgedAt,
  };
}

/**
 * Rebuild a runtime claim from a persisted record. Requires the Fr constructor
 * (injected so this module stays import-light and unit-testable without the SDK).
 */
export function deserializeClaim(s: SerializedClaim, Fr: { fromHexString: (h: string) => any }): FeeJuiceClaim {
  return {
    claimAmount: BigInt(s.claimAmount),
    claimSecret: Fr.fromHexString(s.claimSecret),
    claimSecretHash: Fr.fromHexString(s.claimSecretHash),
    messageHash: s.messageHash,
    messageLeafIndex: BigInt(s.messageLeafIndex),
  };
}

// ---------------------------------------------------------------------------
// Claim-store persistence
// ---------------------------------------------------------------------------

/**
 * Resolve the claim-store path. Defaults to ~/.aztec-triad-private/
 * fee-juice-claims.json — OUTSIDE the repo, alongside the treasury key, so claim
 * secrets can never be accidentally committed. Override with FEE_JUICE_CLAIMS_FILE.
 */
export function claimStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FEE_JUICE_CLAIMS_FILE) return resolve(env.FEE_JUICE_CLAIMS_FILE);
  return resolve(homedir(), '.aztec-triad-private', 'fee-juice-claims.json');
}

/**
 * Read + validate the L1 funder (treasury) private key, never logging it.
 * Prefers TREASURY_L1_KEY; else reads TREASURY_L1_KEY_FILE (default
 * ~/.aztec-triad-private/treasury-l1-key.txt, chmod 600). Throws if absent or
 * not a 0x 32-byte hex key. Used by both fund-testnet and deploy-testnet's
 * inline-bridge path so the key handling stays in one place.
 */
/**
 * The Sepolia RPC the scripts and the playtest harness use when
 * TESTNET_L1_RPC_URL is unset.
 *
 * It has to answer reads consistently with the receipts it hands out, and the
 * public publicnode endpoint does not: it balances across nodes, and on
 * 23 November 2026 7 of 24 nonce reads taken straight after a receipt came
 * from a node that had not seen the transaction. Every failure that caused
 * looked like an app bug: a funded wallet read as empty ("have 0"), an
 * approved allowance read as none. thirdweb's endpoint gave none in 72 (same
 * test: a 0-ETH self-transfer from the treasury, then six nonce reads 300 ms
 * apart once its receipt arrived). Set TESTNET_L1_RPC_URL to override.
 */
export const DEFAULT_L1_RPC = 'https://sepolia.rpc.thirdweb.com';

export function readFunderKey(env: NodeJS.ProcessEnv = process.env): string {
  let key = env.TREASURY_L1_KEY?.trim();
  if (!key) {
    const file =
      env.TREASURY_L1_KEY_FILE?.replace(/^~/, homedir()) ||
      resolve(homedir(), '.aztec-triad-private', 'treasury-l1-key.txt');
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      throw new Error(`No treasury L1 key: set TREASURY_L1_KEY or place it at ${file} (chmod 600).`);
    }
    const trimmed = content.trim();
    if (!trimmed) throw new Error(`Treasury key file ${file} is empty.`);
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      key = trimmed; // the whole file is exactly the key
    } else {
      // Labeled / multi-line key file (e.g. a header line + the key): extract the
      // single 0x 32-byte hex key embedded in it. (An L1 address is 40 hex, so a
      // 64-hex match is unambiguously the private key.)
      const m = content.match(/0x[0-9a-fA-F]{64}/);
      if (!m) {
        throw new Error(
          `Treasury key file ${file} contains no 0x 32-byte hex private key. ` +
            `Put a bare 0x-prefixed 32-byte key in it, or set TREASURY_L1_KEY.`,
        );
      }
      key = m[0];
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Treasury L1 key must be a 0x-prefixed 32-byte hex private key.');
  }
  return key;
}

export function loadClaimStore(path: string): ClaimStore {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as ClaimStore;
}

/** Write the store atomically-ish with 0600 perms (it holds claim secrets). */
export function saveClaimStore(path: string, store: ClaimStore): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function getStoredClaim(store: ClaimStore, l2Address: string): SerializedClaim | undefined {
  return store[l2Address.toLowerCase()];
}

/** Upsert a claim and persist. Returns the updated store. */
export function putStoredClaim(path: string, l2Address: string, record: SerializedClaim): ClaimStore {
  const store = loadClaimStore(path);
  store[l2Address.toLowerCase()] = record;
  saveClaimStore(path, store);
  return store;
}

/** Mark a stored claim consumed (no-op if absent). */
export function markClaimConsumed(path: string, l2Address: string): void {
  const store = loadClaimStore(path);
  const rec = store[l2Address.toLowerCase()];
  if (rec) {
    rec.status = 'consumed';
    saveClaimStore(path, store);
  }
}

// ---------------------------------------------------------------------------
// Bridging (impure; needs L1 RPC + funder key + an Aztec node)
// ---------------------------------------------------------------------------

export interface BridgeParams {
  /** Aztec node client (from createAztecNodeClient). */
  node: any;
  /** L1 (Sepolia for testnet) RPC URL. */
  l1RpcUrl: string;
  /** L1 funder private key (0x hex) — the treasury that holds Sepolia ETH. */
  funderKey: string;
  /** Destination L2 account address (0x hex). */
  l2Address: string;
  log: LogFn;
  /** Seconds to wait for the L1->L2 message to land in the tree. */
  messageWaitSeconds?: number;
  /** Fee Juice to bridge (base units). Default DEFAULT_BRIDGE_AMOUNT. */
  amount?: bigint;
}

/** Multicall3 — the same address on every EVM chain, Sepolia included. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * Fee Juice bridged per account unless the caller asks for more. Measured on
 * the v6 testnet (20 Nov 2026): a full contract deploy spent 19, a five-game
 * playtest campaign 14 at most. 100 leaves 5x headroom over the heaviest, and
 * one faucet mint (1000) then funds ten bridges instead of one.
 */
export const DEFAULT_BRIDGE_AMOUNT = 100n * 10n ** 18n;

const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Inbox inserts swing by ~40k gas with the message index they land on, so an
 * estimate taken now can under-size the deposit when it mines. The SDK doubles
 * its deposit estimates for the same reason (inboxDepositGasConfig); unused gas
 * is not charged.
 */
const DEPOSIT_GAS_MULTIPLIER = 2n;

/**
 * Bridge `amount` Fee Juice from L1 to one L2 address and wait for the L1->L2
 * message to be included. Returns the claim; the caller persists it and the
 * destination account consumes it via FeeJuicePaymentMethodWithClaim.
 *
 * A bridge is exactly ONE L1 transaction, and in the steady state the cheapest
 * one there is: a plain `depositToAztecPublic` from the funder, drawing on a
 * Fee Juice float the funder already holds through an allowance it granted the
 * portal once. That deposit is the portal's own cost (~290k gas on the v6
 * testnet, almost all of it the Inbox insert) and nothing else is spent.
 *
 * When the float cannot cover the bridge (first use, or every
 * mintAmount/amount bridges) it is one atomic transaction through Multicall3
 * instead: mint from the faucet, approve, deposit this bridge's share, and park
 * the rest with the funder as the next float. The standing allowance is granted
 * once, the first time a float exists without it.
 *
 * Why this shape: the SDK's bridgeTokensPublic sends mint, approve and deposit
 * as three transactions (~460-560k gas per bridge) and pre-flights each through
 * the RPC; on a load-balanced public endpoint the deposit's estimate could land
 * on a node that had not seen the approve yet and revert
 * ERC20InsufficientAllowance (2 of 7 testnet bridges, 20 Nov 2026). Here no
 * transaction depends on another one sent moments earlier: the deposit reads
 * only a float and an allowance settled by earlier bridges, the cold start does
 * everything inside one transaction, and nonces come from a local nonce
 * manager rather than a fresh RPC read.
 *
 * Multicall3 is a stateless relay: it holds Fee Juice only inside the
 * transaction that mints and spends it, and the claim belongs to whoever holds
 * the claim secret, not to the L1 sender. Throws (does not mask) if a
 * transaction reverts, if the receipt carries no deposit event for our secret
 * hash, or if the message has not arrived within messageWaitSeconds.
 */
export async function bridgeFeeJuice(params: BridgeParams): Promise<FeeJuiceClaim> {
  const { node, l1RpcUrl, funderKey, l2Address, log } = params;
  const messageWaitSeconds = params.messageWaitSeconds ?? 600;
  const amount = params.amount ?? DEFAULT_BRIDGE_AMOUNT;

  const [{ generateClaimSecret }, { AztecAddress }, { Fr }, artifacts, viem, accounts] =
    await Promise.all([
      import('@aztec-labs/aztec.js/ethereum'),
      import('@aztec-labs/aztec.js/addresses'),
      import('@aztec-labs/aztec.js/fields'),
      import('@aztec-foundation/l1-artifacts'),
      import('viem'),
      import('viem/accounts'),
    ]);
  const { FeeAssetHandlerAbi, FeeJuicePortalAbi, TestERC20Abi } = artifacts;
  const { createWalletClient, defineChain, encodeFunctionData, formatUnits, http, multicall3Abi, parseEventLogs, publicActions } = viem;
  const fj = (v: bigint) => `${formatUnits(v, 18)} FJ`;

  const l2 = AztecAddress.fromStringUnsafe(l2Address).toString() as `0x${string}`;

  // Determine the L1 chain id from the RPC and pass it EXPLICITLY, so the
  // signer never falls back to a default chain id and gets its txs rejected
  // with "invalid chain id for signer".
  const chainIdResp: any = await fetch(l1RpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
  }).then((r) => r.json());
  const chainId = parseChainIdHex(chainIdResp.result);
  log(`L1 chain id: ${chainId}`);
  const chain = defineChain({
    id: chainId,
    name: `l1-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [l1RpcUrl] } },
  });
  // A local nonce manager: consecutive transactions (a bridge, the one-time
  // allowance, the next account's bridge) take nonces from a counter in this
  // process instead of re-reading them from an RPC that may not have caught up.
  const account = accounts.privateKeyToAccount(funderKey as `0x${string}`, { nonceManager: accounts.nonceManager });
  const l1Client: any = createWalletClient({ account, chain, transport: http(l1RpcUrl) }).extend(publicActions);
  const funder = account.address;

  const { l1ContractAddresses: l1 } = await node.getNodeInfo();
  const handler = l1.feeAssetHandlerAddress.toString() as `0x${string}`;
  const feeJuice = l1.feeJuiceAddress.toString() as `0x${string}`;
  const portal = l1.feeJuicePortalAddress.toString() as `0x${string}`;

  const [claimSecret, claimSecretHash] = await generateClaimSecret();
  const secretHash = claimSecretHash.toString() as `0x${string}`;
  const [float, allowance] = (await Promise.all([
    l1Client.readContract({ address: feeJuice, abi: TestERC20Abi, functionName: 'balanceOf', args: [funder] }),
    l1Client.readContract({ address: feeJuice, abi: TestERC20Abi, functionName: 'allowance', args: [funder, portal] }),
  ])) as [bigint, bigint];

  const depositGas = async (request: object) =>
    (await l1Client.estimateContractGas({ ...request, account })) * DEPOSIT_GAS_MULTIPLIER;
  let hash: `0x${string}`;
  if (float >= amount && allowance >= amount) {
    log(`Bridging ${fj(amount)} -> ${l2Address.slice(0, 18)}... from the funder's float of ${fj(float)} (one deposit)`);
    const request = {
      address: portal,
      abi: FeeJuicePortalAbi,
      functionName: 'depositToAztecPublic',
      args: [l2, amount, secretHash],
    } as const;
    hash = await l1Client.writeContract({ ...request, account, gas: await depositGas(request) });
  } else {
    const mintAmount = (await l1Client.readContract({
      address: handler,
      abi: FeeAssetHandlerAbi,
      functionName: 'mintAmount',
    })) as bigint;
    const mints = (amount + mintAmount - 1n) / mintAmount;
    const rest = mints * mintAmount - amount;
    const call = (target: `0x${string}`, callData: `0x${string}`) => ({ target, allowFailure: false, callData });
    const calls = [
      ...Array.from({ length: Number(mints) }, () =>
        call(handler, encodeFunctionData({ abi: FeeAssetHandlerAbi, functionName: 'mint', args: [MULTICALL3_ADDRESS] }))),
      call(feeJuice, encodeFunctionData({ abi: TestERC20Abi, functionName: 'approve', args: [portal, amount] })),
      call(portal, encodeFunctionData({
        abi: FeeJuicePortalAbi,
        functionName: 'depositToAztecPublic',
        args: [l2, amount, secretHash],
      })),
      ...(rest > 0n
        ? [call(feeJuice, encodeFunctionData({ abi: TestERC20Abi, functionName: 'transfer', args: [funder, rest] }))]
        : []),
    ];
    log(
      `Bridging ${fj(amount)} -> ${l2Address.slice(0, 18)}... in one tx: mint ${fj(mints * mintAmount)}, ` +
        `deposit ${fj(amount)}, park ${fj(rest)} as the funder's next float (float was ${fj(float)})`,
    );
    const request = { address: MULTICALL3_ADDRESS, abi: multicall3Abi, functionName: 'aggregate3', args: [calls] } as const;
    hash = await l1Client.writeContract({ ...request, account, gas: await depositGas(request) });
  }
  log(`  L1 tx ${hash}`);
  const receipt = await l1Client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Bridge tx ${hash} reverted on L1 (block ${receipt.blockNumber}).`);
  }
  const deposit = parseEventLogs({ abi: FeeJuicePortalAbi, eventName: 'DepositToAztecPublic', logs: receipt.logs })
    .find((e: any) =>
      e.address.toLowerCase() === portal.toLowerCase() &&
      e.args.secretHash.toLowerCase() === secretHash.toLowerCase());
  if (!deposit) {
    throw new Error(`Bridge tx ${hash} succeeded but emitted no DepositToAztecPublic for our secret hash.`);
  }
  const { key, index } = (deposit as any).args as { key: `0x${string}`; index: bigint };
  log(`Bridged in L1 block ${receipt.blockNumber} for ${receipt.gasUsed} gas. leafIndex=${index}`);

  // Grant the portal a standing allowance on the funder's float, once, so later
  // bridges are a single plain deposit. Settled long before the next bridge
  // reads it: the L1->L2 wait below alone takes a minute or more.
  if (allowance < MAX_UINT256 / 2n) {
    const approveHash = await l1Client.writeContract({
      address: feeJuice,
      abi: TestERC20Abi,
      functionName: 'approve',
      args: [portal, MAX_UINT256],
      account,
    });
    const approved = await l1Client.waitForTransactionReceipt({ hash: approveHash });
    if (approved.status !== 'success') throw new Error(`Standing portal allowance tx ${approveHash} reverted.`);
    log(`Standing portal allowance granted on the funder's float (${approved.gasUsed} gas, once).`);
  }

  const claim: FeeJuiceClaim = {
    claimAmount: amount,
    claimSecret,
    claimSecretHash,
    messageHash: key,
    messageLeafIndex: index,
  };

  // Wait for the L1->L2 message to be included in the L2 tree. On testnet the
  // public sequencer mines blocks on its own (no SEQ_MIN_TX_PER_BLOCK=0 needed),
  // so this is a straight poll until the witness exists.
  const messageHash = Fr.fromHexString(key);
  log(`Waiting up to ${messageWaitSeconds}s for the L1->L2 message to be included...`);
  let confirmed = false;
  for (let i = 0; i < messageWaitSeconds; i++) {
    try {
      const witness = await node.getL1ToL2MessageMembershipWitness('latest', messageHash);
      if (witness) {
        confirmed = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!confirmed) {
    throw new Error(
      `L1->L2 message ${key} not included within ${messageWaitSeconds}s. ` +
        `The bridge tx is mined and the claim is persisted; re-run once Sepolia propagates, ` +
        `or raise messageWaitSeconds.`,
    );
  }
  log('L1->L2 message confirmed in tree.');
  return claim;
}
