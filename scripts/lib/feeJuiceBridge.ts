/**
 * Fee Juice bridging core (L1 -> L2), shared by the funding + deploy scripts.
 *
 * Fee Juice is NON-TRANSFERABLE on L2: an account cannot send it to another
 * account. The ONLY way to fund an account is to bridge from L1 via the
 * L1FeeJuicePortalManager and have the account *claim* the resulting L1->L2
 * message in a transaction (FeeJuicePaymentMethodWithClaim). This module
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
export function readFunderKey(env: NodeJS.ProcessEnv = process.env): string {
  let key = env.TREASURY_L1_KEY?.trim();
  if (!key) {
    const file =
      env.TREASURY_L1_KEY_FILE?.replace(/^~/, homedir()) ||
      resolve(homedir(), '.aztec-triad-private', 'treasury-l1-key.txt');
    try {
      key = readFileSync(file, 'utf-8').trim();
    } catch {
      throw new Error(`No treasury L1 key: set TREASURY_L1_KEY or place it at ${file} (chmod 600).`);
    }
    if (!key) throw new Error(`Treasury key file ${file} is empty.`);
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
}

/**
 * Bridge Fee Juice from L1 to a single L2 address and wait for the L1->L2
 * message to be included. mint=true uses the FeeAssetHandler so the funder does
 * not need to pre-hold Fee Juice ERC20 — only L1 (Sepolia) ETH for gas.
 *
 * Returns the full claim. The caller persists it; the destination account
 * consumes it later via FeeJuicePaymentMethodWithClaim. Throws (does not mask)
 * if the message has not arrived within messageWaitSeconds — the bridge tx is
 * already mined, so re-running will reuse the funder's L1 balance, and the claim
 * the caller already persisted (before the wait) stays valid.
 */
export async function bridgeFeeJuice(params: BridgeParams): Promise<FeeJuiceClaim> {
  const { node, l1RpcUrl, funderKey, l2Address, log } = params;
  const messageWaitSeconds = params.messageWaitSeconds ?? 600;

  const [{ L1FeeJuicePortalManager }, { AztecAddress }, { createExtendedL1Client }, { Fr }] = await Promise.all([
    import('@aztec/aztec.js/ethereum'),
    import('@aztec/aztec.js/addresses'),
    import('@aztec/ethereum/client'),
    import('@aztec/aztec.js/fields'),
  ]);

  const l2 = AztecAddress.fromString(l2Address);

  // createExtendedL1Client accepts a raw private key (not just a mnemonic) and
  // auto-detects the chain from the RPC's eth_chainId, so no chain arg needed.
  const l1Client = createExtendedL1Client([l1RpcUrl], funderKey);

  const portalManager = await L1FeeJuicePortalManager.new(node, l1Client, {
    info: log,
    warn: log,
    error: log,
    debug: () => {},
    verbose: () => {},
  } as any);

  log(`Bridging Fee Juice -> ${l2Address.slice(0, 18)}... (mint via FeeAssetHandler)`);
  const result = await portalManager.bridgeTokensPublic(l2, undefined, true);
  log(`Bridged. claimAmount=${result.claimAmount} leafIndex=${result.messageLeafIndex}`);

  const claim: FeeJuiceClaim = {
    claimAmount: result.claimAmount,
    claimSecret: result.claimSecret,
    claimSecretHash: result.claimSecretHash,
    messageHash: result.messageHash,
    messageLeafIndex: result.messageLeafIndex,
  };

  // Wait for the L1->L2 message to be included in the L2 tree. On testnet the
  // public sequencer mines blocks on its own (no SEQ_MIN_TX_PER_BLOCK=0 needed),
  // so this is a straight poll until the witness exists.
  const messageHash = Fr.fromHexString(result.messageHash);
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
      `L1->L2 message ${result.messageHash} not included within ${messageWaitSeconds}s. ` +
        `The bridge tx is mined and the claim is persisted; re-run once Sepolia propagates, ` +
        `or raise messageWaitSeconds.`,
    );
  }
  log('L1->L2 message confirmed in tree.');
  return claim;
}
