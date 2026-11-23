/**
 * Connecting Nulo through the standard wallet-sdk flow. The fake discovery
 * stands in for WalletManager; everything else (the emoji grid, the manifest
 * schema) is the SDK's own code.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  connectNulo, capabilityManifest, grantedAccounts, isNulo, verificationEmojis, nuloErrorMessage,
  NuloCancelledError, NuloNotFoundError, NULO_APP_ID, type NuloStep, type WalletDiscovery,
} from './nuloWallet';

const CONTRACTS = {
  nft: '0x02db82b84e4e1aa56a051f756d6bf2e570674baf6a999ad5296f86f4bd98de67',
  game: '0x272c03ee5a5d201220fe0222fa25c22a2ac1c9a66802d64893287d0531fef4ac',
  token: '0x2996e80694344fd561fab2aa2db0ddedba846234c47a9a68f6b8d6ba7bc6b5d5',
};
const PLAYER = '0x1111111111111111111111111111111111111111111111111111111111111111';
/** As the SDK derives it: 32 bytes of bare hex, no 0x (arrayBufferToHex). */
const HASH = '0123456789abcdef'.repeat(4);
const CHAIN = { chainId: { toString: () => '11155111' }, version: { toString: () => '679261766' } } as never;

function fakeWallet(opts: { granted?: string[]; accounts?: string[] } = {}) {
  return {
    requestCapabilities: vi.fn(async () => ({
      version: '1.0',
      granted: opts.granted ? [{ type: 'accounts', canGet: true, accounts: opts.granted.map(a => ({ alias: 'main', item: a })) }] : [],
    })),
    getAccounts: vi.fn(async () => (opts.accounts ?? []).map(a => ({ alias: 'main', item: { toString: () => a } }))),
  };
}

function fakeProvider(id: string, name: string, wallet = fakeWallet({ granted: [PLAYER] })) {
  const pending = { verificationHash: HASH, confirm: vi.fn(async () => wallet), cancel: vi.fn() };
  return {
    id, name, type: 'extension' as const,
    establishSecureChannel: vi.fn(async () => pending),
    disconnect: vi.fn(async () => {}),
    onDisconnect: vi.fn(() => () => {}),
    isDisconnected: () => false,
    pending, wallet,
  };
}

/** Discovery that yields the given providers, then ends. */
function fakeDiscovery(providers: ReturnType<typeof fakeProvider>[], opts: { hang?: boolean } = {}) {
  const cancel = vi.fn();
  let cancelled = false;
  const discovery: WalletDiscovery = {
    getAvailableWallets: vi.fn(() => ({
      wallets: (async function* () {
        for (const p of providers) yield p as never;
        // A real session keeps listening until its timeout; model that.
        while (opts.hang && !cancelled) await new Promise(r => setTimeout(r, 5));
      })(),
      done: Promise.resolve(),
      cancel: () => { cancelled = true; cancel(); },
    })),
  };
  return { discovery, cancel };
}

const base = () => ({ chainInfo: CHAIN, contracts: CONTRACTS, appVersion: '1.0.0', onStep: vi.fn<(s: NuloStep) => void>() });

describe('isNulo', () => {
  it('recognises Nulo by its wallet id or its name, and nothing else', () => {
    expect(isNulo({ id: 'nulo', name: 'Something' })).toBe(true);
    expect(isNulo({ id: 'x', name: 'Nulo' })).toBe(true);
    expect(isNulo({ id: 'azguard', name: 'Azguard Wallet' })).toBe(false);
  });
});

describe('the permission request', () => {
  it('is a valid wallet-sdk manifest, scoped to the three game contracts, asking for no authwits', async () => {
    const manifest = await capabilityManifest(CONTRACTS, '1.0.0', 'https://www.aztec-arena.com');
    // Check what Nulo receives: the extension wallet sends every call through
    // jsonStringify, and the wallet parses it with the SDK's own schema.
    const [{ AppCapabilitiesSchema }, { jsonStringify }] = await Promise.all([
      import('@aztec-labs/aztec.js/wallet'),
      import('@aztec-labs/foundation/json-rpc'),
    ]);
    expect(() => AppCapabilitiesSchema.parse(JSON.parse(jsonStringify(manifest)))).not.toThrow();

    const ours = [CONTRACTS.nft, CONTRACTS.game, CONTRACTS.token];
    const byType = Object.fromEntries(manifest.capabilities.map(c => [c.type, c as never])) as Record<string, any>;
    expect(byType.accounts).toEqual({ type: 'accounts', canGet: true });
    expect(byType.contracts.contracts.map(String)).toEqual(ours);
    for (const scope of [byType.simulation.transactions.scope, byType.simulation.utilities.scope, byType.transaction.scope]) {
      expect(scope.map((p: any) => [String(p.contract), p.function])).toEqual(ours.map(c => [c, '*']));
    }
    // Registering the contracts as note senders is an address-book operation;
    // no private events are read.
    expect(byType.data).toEqual({ type: 'data', addressBook: true });
  });

  it('reads the shared accounts from the granted side of the response', () => {
    expect(grantedAccounts({ granted: [{ type: 'contracts' }, { type: 'accounts', accounts: [{ alias: 'a', item: PLAYER }] }] }))
      .toEqual([PLAYER]);
    expect(grantedAccounts({ granted: [] })).toEqual([]);
    expect(grantedAccounts(null)).toEqual([]);
  });
});

describe('the verification emojis', () => {
  it('are nine, one per byte of the hash, written the way Nulo draws them', async () => {
    // 0x83 is 🖥 (a text symbol unless asked otherwise), 0x6d is ⬛ (colour by
    // default, but drawn flat on some platforms), 0xe7 is 🔮 (always colour).
    const emojis = await verificationEmojis('836de7'.repeat(11));

    expect(emojis).toHaveLength(9);
    expect(emojis.slice(0, 3)).toEqual(['🖥\uFE0F', '⬛\uFE0F', '🔮']);
  });
});

describe('nuloErrorMessage', () => {
  const walletError = (data: object) => new Error(JSON.stringify({ code: 4100, message: 'x capability not granted.', data }));

  it('tells a player who switched off the address book what it is for and what to do', () => {
    const msg = nuloErrorMessage(walletError({ walletErrorCode: 'CAPABILITY_NOT_GRANTED', capabilityType: 'data' }));
    expect(msg).toMatch(/See your address book/);
    expect(msg).toMatch(/Connect again/);
  });

  it('names any other missing permission', () => {
    expect(nuloErrorMessage(walletError({ walletErrorCode: 'CAPABILITY_NOT_GRANTED', capabilityType: 'transaction' })))
      .toMatch(/permission it needs \(transaction\)/);
  });

  it('unwraps any other wallet error to its message, and leaves plain errors alone', () => {
    expect(nuloErrorMessage(walletError({ walletErrorCode: 'OTHER' }))).toBe('x capability not granted.');
    expect(nuloErrorMessage(new Error('Nulo did not answer.'))).toBe('Nulo did not answer.');
  });
});

describe('connectNulo', () => {
  it('picks Nulo out of the wallets that answer, verifies the channel, and returns the shared account', async () => {
    const other = fakeProvider('azguard', 'Azguard');
    const nulo = fakeProvider('nulo', 'Nulo');
    const { discovery } = fakeDiscovery([other, nulo]);
    const opts = base();
    const shown: string[][] = [];

    const conn = await connectNulo({
      ...opts, discovery,
      confirmEmojis: async (emojis) => { shown.push(emojis); return true; },
    });

    expect(conn.accountAddress).toBe(PLAYER);
    expect(conn.provider).toBe(nulo);
    expect(other.establishSecureChannel).not.toHaveBeenCalled();
    expect(nulo.establishSecureChannel).toHaveBeenCalledWith(NULO_APP_ID);
    // The grid the player compares is the SDK's own rendering of the hash.
    expect(shown).toEqual([await verificationEmojis(HASH)]);
    expect(shown[0]).toHaveLength(9);
    expect(nulo.pending.confirm).toHaveBeenCalled();
    expect(nulo.wallet.requestCapabilities).toHaveBeenCalledTimes(1);
    expect(opts.onStep.mock.calls.map(([s]) => s.step)).toEqual(['discovering', 'verifying', 'permissions']);
  });

  it('refuses the connection when the emojis do not match, without confirming it', async () => {
    const nulo = fakeProvider('nulo', 'Nulo');
    const { discovery } = fakeDiscovery([nulo]);

    await expect(connectNulo({ ...base(), discovery, confirmEmojis: async () => false }))
      .rejects.toBeInstanceOf(NuloCancelledError);
    expect(nulo.pending.confirm).not.toHaveBeenCalled();
    expect(nulo.pending.cancel).toHaveBeenCalled();
  });

  it('lets go of Nulo when the player refuses the permissions', async () => {
    const wallet = fakeWallet({ granted: [PLAYER] });
    wallet.requestCapabilities.mockRejectedValue(new Error('User rejected the request'));
    const nulo = fakeProvider('nulo', 'Nulo', wallet);
    const { discovery } = fakeDiscovery([nulo]);

    await expect(connectNulo({ ...base(), discovery, confirmEmojis: async () => true })).rejects.toThrow(/rejected/);
    expect(nulo.disconnect).toHaveBeenCalled();
  });

  it('says Nulo is missing when only other wallets answer', async () => {
    const { discovery, cancel } = fakeDiscovery([fakeProvider('azguard', 'Azguard')]);

    await expect(connectNulo({ ...base(), discovery, confirmEmojis: async () => true }))
      .rejects.toBeInstanceOf(NuloNotFoundError);
    expect(cancel).toHaveBeenCalled();
  });

  it('falls back to getAccounts when the grant lists no account', async () => {
    const nulo = fakeProvider('nulo', 'Nulo', fakeWallet({ granted: [], accounts: [PLAYER] }));
    const { discovery } = fakeDiscovery([nulo]);

    const conn = await connectNulo({ ...base(), discovery, confirmEmojis: async () => true });
    expect(conn.accountAddress).toBe(PLAYER);
  });

  it('fails, and lets go of Nulo, when no account is shared at all', async () => {
    const nulo = fakeProvider('nulo', 'Nulo', fakeWallet({ granted: [], accounts: [] }));
    const { discovery } = fakeDiscovery([nulo]);

    await expect(connectNulo({ ...base(), discovery, confirmEmojis: async () => true }))
      .rejects.toThrow(/did not share an account/);
    expect(nulo.disconnect).toHaveBeenCalled();
  });

  it('stops discovery when cancelled while waiting for Nulo', async () => {
    const { discovery, cancel } = fakeDiscovery([], { hang: true });
    const abort = new AbortController();
    const connecting = connectNulo({ ...base(), discovery, confirmEmojis: async () => true, signal: abort.signal });

    setTimeout(() => abort.abort(), 20);
    await expect(connecting).rejects.toBeInstanceOf(NuloCancelledError);
    expect(cancel).toHaveBeenCalled();
  });
});
