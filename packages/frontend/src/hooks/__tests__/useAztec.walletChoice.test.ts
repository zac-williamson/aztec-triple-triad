/**
 * The wallet choice: a player is asked once whether to use Nulo or the
 * in-browser wallet, and the app connects with whichever they picked. The
 * in-browser wallet's machinery (keys, funding, deploy) must never run for a
 * Nulo player.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  prepareConnection: vi.fn(),
  deployAndRegister: vi.fn(),
  setupConnectedWallet: vi.fn(),
  setPxeWallet: vi.fn(),
  connectNulo: vi.fn(),
  getNodeInfo: vi.fn(),
  emojiAnswered: null as null | Promise<boolean>,
}));

vi.mock('../../aztec/AztecContext', () => ({
  AZTEC_CONFIG: {
    enabled: true,
    pxeUrl: 'https://aztec-testnet.example',
    nftContractAddress: '0xNFT', gameContractAddress: '0xGAME', tokenContractAddress: '0xTOKEN',
    storageKeys: { accountAddress: 'acct' },
  },
}));
vi.mock('../../aztec/connectToAztec', () => ({
  prepareConnection: h.prepareConnection,
  deployAndRegister: h.deployAndRegister,
  setupConnectedWallet: h.setupConnectedWallet,
}));
vi.mock('../../aztec/pxe', () => ({
  setPxeWallet: h.setPxeWallet,
  runPxeTx: vi.fn(async ({ execute }: { execute: (ops: unknown, setPhase: (p: string) => void) => unknown }) =>
    execute({ ops: true }, () => {})),
  pxe: { readPrivateCards: vi.fn(async () => []), readTokenBalance: vi.fn(async () => 0) },
}));
vi.mock('../../aztec/pxeKeepSynced', () => ({ startPxeKeepSynced: vi.fn(() => () => {}) }));
vi.mock('@aztec-labs/aztec.js/node', () => ({
  createAztecNodeClient: () => ({ getNodeInfo: h.getNodeInfo }),
}));
vi.mock('../../aztec/nuloWallet', () => ({ connectNulo: h.connectNulo }));
// The real module takes seconds to load on a busy machine, which is long
// enough to time a test out and leave its connection finishing in the next.
vi.mock('@aztec-labs/aztec.js/fields', () => ({
  Fr: class { constructor(private v: number | bigint) {} toBigInt() { return BigInt(this.v); } },
}));

import { useAztec } from '../useAztec';
import { WALLET_KIND_KEY } from '../../aztec/walletChoice';

const NULO_WALLET = { nulo: 'wallet' };
const PLAYER = '0xPLAYER';

function nuloProvider() {
  let onDisconnect: (() => void) | null = null;
  return {
    disconnect: vi.fn(async () => {}),
    onDisconnect: vi.fn((cb: () => void) => { onDisconnect = cb; return () => {}; }),
    fireDisconnect: () => onDisconnect?.(),
  };
}

/** A connectNulo that behaves like the real one around the emoji question. */
function nuloConnects(provider = nuloProvider()) {
  h.connectNulo.mockImplementation(async (opts: any) => {
    opts.onStep({ step: 'discovering' });
    opts.onStep({ step: 'verifying', emojis: ['🦊', '🐸', '🎲'] });
    const match = await opts.confirmEmojis(['🦊', '🐸', '🎲']);
    if (opts.signal?.aborted) throw new Error('Connection cancelled.');
    if (!match) throw new Error('The emojis did not match');
    opts.onStep({ step: 'permissions' });
    return { wallet: NULO_WALLET, provider, accountAddress: PLAYER };
  });
  return provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.getNodeInfo.mockResolvedValue({ l1ChainId: 11155111, rollupVersion: 679261766 });
  h.setupConnectedWallet.mockResolvedValue({ wallet: NULO_WALLET, node: {}, accountAddress: PLAYER, ownedCardIds: [1, 2, 3, 4, 5] });
  h.prepareConnection.mockResolvedValue({ wallet: { embedded: true }, node: {}, accountAddress: '0xEMBEDDED', alreadyDeployed: true });
  h.deployAndRegister.mockResolvedValue({ wallet: { embedded: true }, node: {}, accountAddress: '0xEMBEDDED', ownedCardIds: [] });
});

describe('the wallet choice', () => {
  it('asks a player who has not chosen, and starts no wallet', async () => {
    const { result } = renderHook(() => useAztec());
    await act(async () => { await result.current.connect(); });

    expect(result.current.status).toBe('choosing-wallet');
    expect(result.current.walletKind).toBeNull();
    expect(h.prepareConnection).not.toHaveBeenCalled();
    expect(h.connectNulo).not.toHaveBeenCalled();
  });

  it('connects a returning player with the wallet they chose before', async () => {
    localStorage.setItem(WALLET_KIND_KEY, 'embedded');
    const { result } = renderHook(() => useAztec());
    await act(async () => { await result.current.connect(); });

    expect(h.prepareConnection).toHaveBeenCalled();
    expect(result.current.status).toBe('connected');
  });

  it('remembers the in-browser wallet as soon as it is chosen', async () => {
    const { result } = renderHook(() => useAztec());
    await act(async () => { await result.current.chooseWallet('embedded'); });

    expect(localStorage.getItem(WALLET_KIND_KEY)).toBe('embedded');
    expect(h.prepareConnection).toHaveBeenCalled();
  });
});

describe('connecting Nulo', () => {
  it('waits for the player to compare emojis, then plays with the account Nulo shared, never touching the in-browser wallet', async () => {
    nuloConnects();
    const { result } = renderHook(() => useAztec());

    let connecting!: Promise<void>;
    act(() => { connecting = result.current.chooseWallet('nulo'); });
    await waitFor(() => expect(result.current.nuloStep).toEqual({ step: 'verifying', emojis: ['🦊', '🐸', '🎲'] }));
    expect(result.current.status).toBe('nulo-connecting');

    await act(async () => { result.current.answerNuloEmojis(true); await connecting; });

    expect(result.current.status).toBe('connected');
    expect(result.current.accountAddress).toBe(PLAYER);
    expect(result.current.ownedCardIds).toEqual([1, 2, 3, 4, 5]);
    expect(h.setPxeWallet).toHaveBeenCalledWith(NULO_WALLET);
    expect(h.setupConnectedWallet).toHaveBeenCalledWith(NULO_WALLET, expect.anything(), PLAYER, { ops: true }, expect.anything());
    expect(h.prepareConnection).not.toHaveBeenCalled();
    expect(localStorage.getItem(WALLET_KIND_KEY)).toBe('nulo');
    // Nulo answers for the network the game is on.
    const { chainInfo } = h.connectNulo.mock.calls[0][0];
    expect([chainInfo.chainId.toBigInt(), chainInfo.version.toBigInt()]).toEqual([11155111n, 679261766n]);
  });

  it('shows the failure, and does not remember Nulo, when it cannot connect', async () => {
    h.connectNulo.mockRejectedValue(new Error('Nulo did not answer.'));
    const { result } = renderHook(() => useAztec());
    await act(async () => { await result.current.chooseWallet('nulo'); });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Nulo did not answer.');
    expect(result.current.walletKind).toBe('nulo');
    expect(localStorage.getItem(WALLET_KIND_KEY)).toBeNull();
  });

  it('goes back to the choice, with no error, when the player cancels', async () => {
    nuloConnects();
    const { result } = renderHook(() => useAztec());
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.chooseWallet('nulo'); });
    await waitFor(() => expect(result.current.nuloStep?.step).toBe('verifying'));

    await act(async () => { result.current.cancelNulo(); await connecting; });

    expect(result.current.status).toBe('choosing-wallet');
    expect(result.current.error).toBeNull();
    expect(h.setupConnectedWallet).not.toHaveBeenCalled();
  });

  it('says so when Nulo drops the connection later', async () => {
    const provider = nuloConnects();
    const { result } = renderHook(() => useAztec());
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.chooseWallet('nulo'); });
    await waitFor(() => expect(result.current.nuloStep?.step).toBe('verifying'));
    await act(async () => { result.current.answerNuloEmojis(true); await connecting; });

    act(() => provider.fireDisconnect());

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/Nulo disconnected/);
    expect(h.setPxeWallet).toHaveBeenLastCalledWith(null);
  });
});
