/**
 * An injected Ethereum wallet, for testing onboarding as a new player sees it.
 *
 * The onboarding flow we ship asks `window.ethereum` for accounts and for
 * signatures. To test it honestly, the ONLY thing that may be simulated is the
 * wallet UI — the key, the chain, the contracts and the money must all be real.
 * So this installs a genuine EIP-1193 provider whose `eth_sendTransaction`
 * signs with a real Sepolia private key and broadcasts to a real Sepolia node;
 * every other method is forwarded to that node untouched. From the app's side
 * it is indistinguishable from MetaMask with auto-approve.
 *
 * The key is generated per run and funded from the treasury with just enough
 * ETH for onboarding, so a leaked test log cannot cost anything.
 */
import type { Page } from '@playwright/test';
import {
  createPublicClient, createWalletClient, http, formatEther,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createRequire } from 'module';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

// scripts/ is CJS (the root package declares no "type"), this package is ESM.
// A plain named import across that boundary fails to resolve under Playwright's
// transform, so require it — still the one treasury-key reader, no second copy
// of the "labelled key file" parsing rule.
const { readFunderKey } = createRequire(import.meta.url)(
  '../../../scripts/lib/feeJuiceBridge.ts',
) as { readFunderKey: (env?: NodeJS.ProcessEnv) => string };

export const L1_RPC = process.env.TESTNET_L1_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

/**
 * Where funded throwaway keys are noted down until they are refunded.
 *
 * A run that is killed cannot be relied on to refund anything. A signal
 * handler helps with Ctrl-C, but a SIGTERM followed promptly by SIGKILL — how
 * a supervisor stops a background job — announces the refund and dies with the
 * RPC call in flight, which is exactly what happened and left two more
 * accounts holding their funding. Money should not depend on winning that
 * race, so every funded key is written down first and struck off once its
 * refund lands. `sweep-throwaways.mts` collects whatever is left.
 *
 * These are single-use Sepolia keys holding ~0.02 test ETH and nothing else,
 * and the file is under .artifacts (gitignored). Set PLAYTEST_KEY_LEDGER=off
 * to skip it.
 */
export const KEY_LEDGER = process.env.PLAYTEST_KEY_LEDGER
  ?? '.artifacts/throwaway-keys.jsonl';

function ledgerAdd(address: Address, privateKey: Hex): void {
  if (KEY_LEDGER === 'off') return;
  try {
    mkdirSync(dirname(KEY_LEDGER), { recursive: true });
    appendFileSync(KEY_LEDGER, JSON.stringify({ address, privateKey, at: new Date().toISOString() }) + '\n');
  } catch { /* the ledger is a safety net, never the thing that fails a run */ }
}

function ledgerRemove(address: Address): void {
  if (KEY_LEDGER === 'off' || !existsSync(KEY_LEDGER)) return;
  try {
    const kept = readFileSync(KEY_LEDGER, 'utf8').split('\n')
      .filter(l => l.trim() && !l.includes(address));
    writeFileSync(KEY_LEDGER, kept.length ? kept.join('\n') + '\n' : '');
  } catch { /* as above */ }
}

/** Every throwaway account still recorded as unrefunded. */
export function pendingThrowaways(): { address: Address; privateKey: Hex; at: string }[] {
  if (!existsSync(KEY_LEDGER)) return [];
  return readFileSync(KEY_LEDGER, 'utf8').split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

/** Enough for mint + approve + deposit with room for a fee spike. */
const DEFAULT_ONBOARDING_ETH = 20_000_000_000_000_000n; // 0.02 ETH

export interface InjectedWallet {
  address: Address;
  privateKey: Hex;
  chainId: number;
  /** Install into a page. Must run before app JS. */
  install: (page: Page) => Promise<void>;
  balance: () => Promise<bigint>;
}

/**
 * Create a brand-new Ethereum account and give it testnet ETH — the exact
 * starting position the test is meant to prove is sufficient: an Ethereum
 * account with some ETH, and nothing else.
 */
export async function createFundedL1Account(
  opts: { fundWei?: bigint; log?: (m: string) => void } = {},
): Promise<InjectedWallet> {
  const log = opts.log ?? (() => {});
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const fundWei = opts.fundWei ?? DEFAULT_ONBOARDING_ETH;

  const pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const treasury = privateKeyToAccount(readFunderKey() as Hex);
  const treasuryWallet = createWalletClient({ account: treasury, chain: sepolia, transport: http(L1_RPC) });

  log(`new Ethereum account ${account.address}`);
  const hash = await treasuryWallet.sendTransaction({ to: account.address, value: fundWei });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Funding the new account reverted (${hash})`);
  log(`funded with ${formatEther(fundWei)} SepoliaETH (${hash})`);
  ledgerAdd(account.address, privateKey);

  return {
    address: account.address,
    privateKey,
    chainId: sepolia.id,
    balance: () => pub.getBalance({ address: account.address }),
    install: (page: Page) => installWallet(page, privateKey),
  };
}

/**
 * An EIP-1193 provider backed by a local key — a wallet, minus the UI.
 *
 * Shared by the browser shim and by Node-side callers, because production code
 * asks a WALLET to sign (`eth_sendTransaction` with an address, not a local
 * account). Handing it a plain RPC transport instead fails with "unknown
 * account": the RPC holds no keys. This is the piece that does.
 */
export function localSignerProvider(privateKey: Hex): {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
} {
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(L1_RPC) });

  return {
    request: async ({ method, params = [] }) => {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address];
        case 'eth_chainId':
          return `0x${sepolia.id.toString(16)}`;
        case 'net_version':
          return String(sepolia.id);
        // Already on the right chain; a real wallet would prompt and return null.
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        case 'eth_sendTransaction': {
          const tx = (params[0] ?? {}) as { to?: Address; data?: Hex; value?: Hex; from?: Address };
          if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
            throw new Error(`Wallet asked to sign for ${tx.from}, which it does not hold`);
          }
          // Gas, nonce and fees are filled by viem against the live node —
          // the same job MetaMask does before showing a confirmation.
          const hash = await wallet.sendTransaction({
            to: tx.to ?? null,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
          });
          console.log(`      [wallet] signed ${hash} -> ${tx.to}`);
          return hash;
        }
        default:
          // Everything else is a plain read against the real chain.
          return pub.request({ method, params } as never);
      }
    },
  };
}

/**
 * Wire a page's `window.ethereum` to a locally-signing wallet.
 *
 * The provider object in the page is deliberately thin: it forwards every call
 * to a Playwright binding, so all the real behaviour lives here in Node where a
 * key can be held safely and a failure is legible in the test output.
 */
export async function installWallet(page: Page, privateKey: Hex): Promise<void> {
  const provider = localSignerProvider(privateKey);

  await page.exposeFunction(
    '__triadWalletRpc',
    (method: string, params: unknown[]) => provider.request({ method, params }),
  );

  // Injected as a STRING, not a function.
  //
  // Playwright serialises a function argument with the transpiler's own output,
  // and esbuild (via tsx) rewrites arrow functions to carry a `__name` helper
  // that exists in the build but not in the page. The init script then dies on
  // `__name is not defined`, window.ethereum is never installed, and the app
  // correctly reports "No Ethereum wallet found" — which reads exactly like a
  // broken funding flow and cost a 25-minute production run to track down.
  // Plain source text cannot be rewritten, so it works under any runner.
  await page.addInitScript({
    content: `
      (function () {
        var listeners = new Map();
        window.ethereum = {
          isMetaMask: true,
          request: function (args) {
            return window.__triadWalletRpc(args.method, args.params || []);
          },
          on: function (event, fn) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
          },
          removeListener: function (event, fn) {
            var s = listeners.get(event);
            if (s) s.delete(fn);
          },
        };
      })();
    `,
  });
}

/** Return whatever ETH is left to the treasury, so runs don't bleed it away. */
export async function refundTreasury(privateKey: Hex, log?: (m: string) => void): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(L1_RPC) });
  const treasury = privateKeyToAccount(readFunderKey() as Hex);
  try {
    const balance = await pub.getBalance({ address: account.address });
    const fees = await pub.estimateFeesPerGas();
    const cost = 21_000n * (fees.maxFeePerGas ?? 0n);
    if (balance <= cost * 2n) { ledgerRemove(account.address); return; } // not worth a transaction
    const hash = await wallet.sendTransaction({ to: treasury.address, value: balance - cost * 2n, gas: 21_000n });
    // Struck off only once the refund has actually MINED. Removing it at send
    // time would discard the record on the one occasion it matters — a
    // transaction that never lands — which is the whole failure the ledger
    // exists to catch. If we are killed during this wait the entry survives and
    // the sweep retries; re-refunding an already-empty account is a no-op.
    await pub.waitForTransactionReceipt({ hash });
    ledgerRemove(account.address);
    log?.(`refunded ~${formatEther(balance - cost * 2n)} ETH to the treasury`);
  } catch (err) {
    log?.(`refund skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
