/**
 * Connecting to Nulo, an Aztec wallet extension for Chrome and Firefox
 * (https://github.com/nulo-sh/nulo). Nulo speaks the standard
 * `@aztec-labs/wallet-sdk` protocol, so what comes back is an ordinary aztec.js
 * `Wallet`: the game code that drives the in-browser wallet drives this one too.
 *
 * Connecting takes three yeses, two of them in Nulo:
 *  1. Discovery. The app asks; Nulo shows the request and the player allows
 *     it. Until then Nulo does not reveal that it is installed.
 *  2. A secure channel. Both sides derive the same key and show it as a grid of
 *     emojis; the player confirms here that the grids match. A script on the
 *     page could otherwise sit between the app and Nulo.
 *  3. Permissions. One request for everything the game needs (an account, our
 *     three contracts, simulations and transactions on them), which Nulo shows
 *     as one prompt where the player also picks the account to play with.
 * After that, every transaction still waits for the player's yes in Nulo.
 */
import type { ChainInfo } from '@aztec-labs/aztec.js/account';
import type { AppCapabilities, Wallet } from '@aztec-labs/aztec.js/wallet';
import type { DiscoverySession, PendingConnection, WalletProvider } from '@aztec-labs/wallet-sdk/manager';

/** How the app introduces itself to the wallet, in discovery and the permission prompt. */
export const NULO_APP_ID = 'axolotl-arena';
export const APP_NAME = 'Axolotl Arena';

/** Nulo's wallet-sdk `walletId`. */
const NULO_WALLET_ID = 'nulo';

/**
 * How long to wait for the player to allow the connection in Nulo. Generous:
 * they may have to unlock Nulo first, and a wallet that is not installed never
 * answers at all, so this is also how long "not installed" takes to show.
 */
export const NULO_DISCOVERY_TIMEOUT_MS = 120_000;

export interface GameContracts {
  nft: string;
  game: string;
  token: string;
}

/** Where a connection is, for the screen that walks the player through it. */
export type NuloStep =
  | { step: 'discovering' }
  | { step: 'verifying'; emojis: string[] }
  | { step: 'permissions' };

/** No Nulo answered: not installed, locked and left, or the player said no. */
export class NuloNotFoundError extends Error {
  constructor() {
    super('Nulo did not answer. Check it is installed and unlocked, then allow Axolotl Arena when it asks.');
    this.name = 'NuloNotFoundError';
  }
}

/** The player stopped the connection: Cancel, or the emoji grids did not match. */
export class NuloCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NuloCancelledError';
  }
}

/** The subset of `WalletManager.configure(...)` the connection uses; a seam for tests. */
export interface WalletDiscovery {
  getAvailableWallets(opts: {
    chainInfo: ChainInfo;
    appId: string;
    timeout?: number;
  }): DiscoverySession;
}

export function isNulo(provider: Pick<WalletProvider, 'id' | 'name'>): boolean {
  return provider.id === NULO_WALLET_ID || /\bnulo\b/i.test(provider.name);
}

/** The verification hash as the emoji grid both sides show, one emoji per cell. */
export async function verificationEmojis(hash: string): Promise<string[]> {
  const { hashToEmoji } = await import('@aztec-labs/wallet-sdk/crypto');
  // Every emoji in the SDK's 256-entry alphabet is one code point, so
  // splitting by code point splits by cell.
  return Array.from(hashToEmoji(hash));
}

/**
 * Everything the game asks of the wallet, requested once so Nulo can show a
 * single prompt. Scoped to our three contracts: the app proposes calls to
 * nothing else (fees and the account's own entrypoint are Nulo's business).
 */
export async function capabilityManifest(
  contracts: GameContracts,
  appVersion: string,
  url?: string,
): Promise<AppCapabilities> {
  const [{ AztecAddress }, { CAPABILITY_VERSION }] = await Promise.all([
    import('@aztec-labs/aztec.js/addresses'),
    import('@aztec-labs/aztec.js/wallet'),
  ]);
  const ours = [contracts.nft, contracts.game, contracts.token]
    .filter(Boolean)
    .map(a => AztecAddress.fromStringUnsafe(a));
  const anyFunctionOn = ours.map(contract => ({ contract, function: '*' }));
  return {
    version: CAPABILITY_VERSION,
    metadata: {
      name: APP_NAME,
      version: appVersion,
      description: 'Triple Triad with private cards, played on Aztec',
      ...(url ? { url } : {}),
    },
    capabilities: [
      // Card reads, previews and note delivery are utilities and simulations;
      // games, packs and settlement are transactions. No authwits are needed.
      { type: 'accounts', canGet: true },
      { type: 'contracts', contracts: ours, canRegister: true, canGetMetadata: true },
      { type: 'simulation', transactions: { scope: anyFunctionOn }, utilities: { scope: anyFunctionOn } },
      { type: 'transaction', scope: anyFunctionOn },
    ],
  };
}

/** The accounts the player shared, from the granted side of a capability response. */
export function grantedAccounts(response: unknown): string[] {
  const granted = (response as { granted?: unknown } | null)?.granted;
  if (!Array.isArray(granted)) return [];
  const cap = granted.find(
    (c): c is { type: 'accounts'; accounts?: { item?: unknown }[] } =>
      typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'accounts',
  );
  return (cap?.accounts ?? [])
    .map(a => (typeof a.item === 'string' ? a.item : a.item ? String(a.item) : ''))
    .filter(Boolean);
}

export interface NuloConnection {
  wallet: Wallet;
  provider: WalletProvider;
  accountAddress: string;
}

/**
 * Find Nulo, open a verified channel and get an account to play with.
 *
 * `confirmEmojis` shows the grid and resolves with the player's answer; the
 * connection is never confirmed on the app's own say-so.
 */
export async function connectNulo(opts: {
  chainInfo: ChainInfo;
  contracts: GameContracts;
  appVersion: string;
  url?: string;
  onStep: (step: NuloStep) => void;
  confirmEmojis: (emojis: string[]) => Promise<boolean>;
  signal?: AbortSignal;
  discovery?: WalletDiscovery;
  timeoutMs?: number;
}): Promise<NuloConnection> {
  const discovery = opts.discovery
    ?? (await import('@aztec-labs/wallet-sdk/manager')).WalletManager.configure({ extensions: { enabled: true } });
  const cancelled = () => new NuloCancelledError('Connection cancelled.');

  opts.onStep({ step: 'discovering' });
  const session = discovery.getAvailableWallets({
    chainInfo: opts.chainInfo,
    appId: NULO_APP_ID,
    timeout: opts.timeoutMs ?? NULO_DISCOVERY_TIMEOUT_MS,
  });
  const stopDiscovery = () => session.cancel();
  opts.signal?.addEventListener('abort', stopDiscovery);

  let provider: WalletProvider | undefined;
  try {
    // Other Aztec wallets may answer too; the player asked for Nulo.
    for await (const candidate of session.wallets) {
      if (isNulo(candidate)) {
        provider = candidate;
        break;
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', stopDiscovery);
    session.cancel();
  }
  if (opts.signal?.aborted) throw cancelled();
  if (!provider) throw new NuloNotFoundError();

  let pending: PendingConnection | undefined;
  try {
    pending = await provider.establishSecureChannel(NULO_APP_ID);
    if (opts.signal?.aborted) throw cancelled();

    const emojis = await verificationEmojis(pending.verificationHash);
    opts.onStep({ step: 'verifying', emojis });
    const match = await opts.confirmEmojis(emojis);
    if (opts.signal?.aborted) throw cancelled();
    if (!match) {
      throw new NuloCancelledError(
        'The emojis did not match, so the connection was refused: something may be sitting between this page and Nulo.',
      );
    }

    const wallet = await pending.confirm();
    pending = undefined;

    opts.onStep({ step: 'permissions' });
    const response = await wallet.requestCapabilities(
      await capabilityManifest(opts.contracts, opts.appVersion, opts.url),
    );
    let accounts = grantedAccounts(response);
    if (accounts.length === 0) {
      // A wallet may grant the capability without listing accounts in it.
      accounts = (await wallet.getAccounts()).map(a => a.item.toString());
    }
    if (accounts.length === 0) {
      await provider.disconnect().catch(() => {});
      throw new Error('Nulo did not share an account. Connect again and pick an account when Nulo asks.');
    }
    return { wallet, provider, accountAddress: accounts[0] };
  } catch (err) {
    pending?.cancel();
    throw err;
  }
}
