/**
 * Production wiring for the Option-B treasury faucet (item I). This is the ONLY
 * file in the backend that reaches the Aztec SDK and `scripts/lib/feeJuiceBridge`,
 * and it does so exclusively through RUNTIME dynamic imports of string-typed
 * specifiers. That keeps the relay's `tsc` build and `package.json` free of any
 * `@aztec/*` dependency (a static import would also trip TS6059 — scripts/ is
 * outside the backend rootDir). The bridge + claim store live behind the
 * injected `FaucetClaimBackend`, so FaucetService stays pure and unit-tested.
 *
 * The treasury L1 key is read here (via the bridge module's `readFunderKey`) and
 * used only to sign L1 bridge txs. It is NEVER returned to the caller and never
 * part of the HTTP wire contract.
 */

import { createFaucetService } from './FaucetService.js';
import type { FaucetClaim, FaucetClaimBackend, FaucetConfig, FaucetService, StoredFaucetClaim } from './types.js';

/**
 * Minimal runtime surface of `scripts/lib/feeJuiceBridge` that we use. Declared
 * locally because the module is loaded dynamically (see header) — this is the
 * adapter's contract against it, not a duplicate of its logic.
 */
export interface FeeJuiceBridgeModule {
  bridgeFeeJuice(params: {
    node: unknown;
    l1RpcUrl: string;
    funderKey: string;
    l2Address: string;
    log: (m: string) => void;
    messageWaitSeconds?: number;
  }): Promise<{
    claimAmount: bigint;
    claimSecret: unknown;
    claimSecretHash: unknown;
    messageHash: string;
    messageLeafIndex: bigint;
  }>;
  readFunderKey(env?: NodeJS.ProcessEnv): string;
  claimStorePath(env?: NodeJS.ProcessEnv): string;
  loadClaimStore(path: string): Record<string, SerializedClaimLike>;
  getStoredClaim(store: Record<string, SerializedClaimLike>, l2Address: string): SerializedClaimLike | undefined;
  serializeClaim(l2Address: string, claim: unknown, bridgedAt: string, status?: 'pending' | 'consumed'): SerializedClaimLike;
  putStoredClaim(path: string, l2Address: string, record: SerializedClaimLike): unknown;
}

/** The persisted claim shape from the bridge module (all JSON-safe strings). */
interface SerializedClaimLike {
  l2Address: string;
  claimAmount: string;
  claimSecret: string;
  claimSecretHash: string;
  messageHash: string;
  messageLeafIndex: string;
  status: 'pending' | 'consumed';
  bridgedAt: string;
}

export interface TreasuryFaucetOptions extends FaucetConfig {
  /** Aztec node URL (testnet RPC) the bridge talks to. */
  nodeUrl: string;
  /** L1 (Sepolia) RPC URL the treasury signs bridge txs against. */
  l1RpcUrl: string;
  /** Treasury L1 key (0x hex). Defaults to the bridge module's readFunderKey(env). Server-only. */
  funderKey?: string;
  /** Seconds to wait for the L1->L2 message to land. */
  messageWaitSeconds?: number;
  log?: (m: string) => void;
  /** Override the bridge-module loader (tests inject a fake). */
  loadBridgeModule?: () => Promise<FeeJuiceBridgeModule>;
  /** Override the Aztec node loader (tests inject a fake). */
  loadNode?: (url: string) => Promise<unknown>;
  /** Path to the compiled bridge module (defaults to FEE_JUICE_BRIDGE_PATH). */
  bridgeModulePath?: string;
}

/** Map a persisted claim record to the consumable HTTP wire claim. */
function wireFromSerialized(s: SerializedClaimLike): FaucetClaim {
  return {
    l2Address: s.l2Address,
    claimAmount: s.claimAmount,
    claimSecret: s.claimSecret,
    claimSecretHash: s.claimSecretHash,
    messageHash: s.messageHash,
    messageLeafIndex: s.messageLeafIndex,
  };
}

function defaultLoadBridgeModule(pathOverride?: string): () => Promise<FeeJuiceBridgeModule> {
  return async () => {
    const modPath = pathOverride ?? process.env.FEE_JUICE_BRIDGE_PATH;
    if (!modPath) {
      throw new Error('FEE_JUICE_BRIDGE_PATH is required to load the fee-juice bridge module');
    }
    // String-typed specifier → not statically resolved by tsc (no TS6059, no
    // @aztec dep pulled into the relay build); resolved at runtime.
    const spec: string = modPath;
    return (await import(spec)) as FeeJuiceBridgeModule;
  };
}

async function defaultLoadNode(url: string): Promise<unknown> {
  const spec: string = '@aztec/aztec.js/node';
  const mod = (await import(spec)) as { createAztecNodeClient: (u: string) => unknown };
  return mod.createAztecNodeClient(url);
}

/**
 * Build a treasury-backed FaucetService. Loads the bridge module once, reads the
 * treasury key, and lazily connects the Aztec node on the first real bridge.
 */
export async function createTreasuryFaucet(options: TreasuryFaucetOptions): Promise<FaucetService> {
  if (!options.nodeUrl) throw new Error('nodeUrl is required for the treasury faucet');
  if (!options.l1RpcUrl) throw new Error('l1RpcUrl is required for the treasury faucet');

  const log = options.log ?? ((m: string) => console.log(`[faucet] ${m}`));
  const loadBridgeModule = options.loadBridgeModule ?? defaultLoadBridgeModule(options.bridgeModulePath);
  const loadNode = options.loadNode ?? defaultLoadNode;

  const bridge = await loadBridgeModule();
  const funderKey = options.funderKey ?? bridge.readFunderKey(process.env);
  const claimPath = bridge.claimStorePath(process.env);

  // Connect the node lazily and reuse it — no L2 connection unless a claim is bridged.
  let nodePromise: Promise<unknown> | null = null;
  const getNode = () => (nodePromise ??= loadNode(options.nodeUrl));

  const backend: FaucetClaimBackend = {
    async getExistingClaim(l2Address: string): Promise<StoredFaucetClaim | null> {
      const rec = bridge.getStoredClaim(bridge.loadClaimStore(claimPath), l2Address);
      return rec ? { claim: wireFromSerialized(rec), status: rec.status } : null;
    },
    async bridgeClaim(l2Address: string): Promise<FaucetClaim> {
      const node = await getNode();
      const claim = await bridge.bridgeFeeJuice({
        node,
        l1RpcUrl: options.l1RpcUrl,
        funderKey,
        l2Address,
        log,
        messageWaitSeconds: options.messageWaitSeconds,
      });
      const rec = bridge.serializeClaim(l2Address, claim, new Date().toISOString(), 'pending');
      bridge.putStoredClaim(claimPath, l2Address, rec);
      return wireFromSerialized(rec);
    },
  };

  return createFaucetService(backend, {
    ipDailyLimit: options.ipDailyLimit,
    globalDailyLimit: options.globalDailyLimit,
    now: options.now,
  });
}

/**
 * Read faucet config from the environment and build the service. Throws with a
 * clear message if a required var is missing — the caller (composition root)
 * logs it and runs relay-only, since the faucet is non-gating.
 */
export async function createTreasuryFaucetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<TreasuryFaucetOptions> = {},
): Promise<FaucetService> {
  const nodeUrl = overrides.nodeUrl ?? env.AZTEC_NODE_URL;
  const l1RpcUrl = overrides.l1RpcUrl ?? env.FAUCET_L1_RPC_URL ?? env.TESTNET_L1_RPC_URL;
  if (!nodeUrl) throw new Error('AZTEC_NODE_URL is required for the faucet');
  if (!l1RpcUrl) throw new Error('FAUCET_L1_RPC_URL (or TESTNET_L1_RPC_URL) is required for the faucet');

  const ipDailyLimit = env.FAUCET_IP_DAILY_LIMIT ? parseInt(env.FAUCET_IP_DAILY_LIMIT, 10) : undefined;
  const globalDailyLimit = env.FAUCET_GLOBAL_DAILY_LIMIT ? parseInt(env.FAUCET_GLOBAL_DAILY_LIMIT, 10) : undefined;

  return createTreasuryFaucet({ nodeUrl, l1RpcUrl, ipDailyLimit, globalDailyLimit, ...overrides });
}
