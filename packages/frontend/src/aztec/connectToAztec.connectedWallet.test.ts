/**
 * Setting up an account that lives in a wallet the player connected (Nulo).
 * The wallet owns the account, so nothing is created or deployed; the game
 * registers its contracts, restores what it stored, and claims starter cards
 * only for an account that has never had any.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  registerGameContracts: vi.fn(),
  fetchTxEffectData: vi.fn(),
  addCards: vi.fn(),
  loadCards: vi.fn(() => [] as unknown[]),
}));

vi.mock('./config', () => ({
  AZTEC_CONFIG: {
    nftContractAddress: '0xNFT', gameContractAddress: '0xGAME', tokenContractAddress: '0xTOKEN',
    storageKeys: { cardsMintedPrefix: 'minted_' },
  },
}));
vi.mock('./contractArtifacts', () => ({ registerGameContracts: h.registerGameContracts }));
vi.mock('./noteImporter', () => ({ fetchTxEffectData: h.fetchTxEffectData, getNftArtifact: vi.fn() }));
vi.mock('./cardStore', () => ({ addCards: h.addCards, loadCards: h.loadCards, saveCards: vi.fn() }));

import { setupConnectedWallet } from './connectToAztec';

const ME = '0xME';
const WALLET = { nulo: true };
const NODE = { node: true };
const MINTED_KEY = `minted_${ME}_0xNFT`;

function fakeOps(heldBefore: number[], heldAfter = [1, 2, 3, 4, 5]) {
  let claimed = false;
  return {
    readPrivateCards: vi.fn(async () => (claimed ? heldAfter : heldBefore)),
    importCardNotes: vi.fn(),
    sendMintStarterCards: vi.fn(async () => { claimed = true; return { txHash: '0xTX', offchainMessages: [{ m: 1 }] }; }),
    computeNoteRandomness: vi.fn(async () => ['0xr0', '0xr1', '0xr2', '0xr3', '0xr4']),
    receiveCardMessages: vi.fn(async () => 5),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.fetchTxEffectData.mockResolvedValue({ noteHashes: ['0xh'], firstNullifier: '0xn' });
});

describe('setupConnectedWallet', () => {
  it('registers the game contracts with the connected wallet and claims nothing for an account with cards', async () => {
    const ops = fakeOps([7, 8, 9, 10, 11]);

    const result = await setupConnectedWallet(WALLET, NODE, ME, ops as never, { log: () => {} });

    expect(h.registerGameContracts).toHaveBeenCalledWith(WALLET, NODE, { nft: '0xNFT', game: '0xGAME', token: '0xTOKEN' }, expect.any(Function));
    expect(ops.sendMintStarterCards).not.toHaveBeenCalled();
    expect(result).toEqual({ wallet: WALLET, node: NODE, accountAddress: ME, ownedCardIds: [7, 8, 9, 10, 11] });
  });

  it('claims the starter cards for an account that has never had any, after saying it is about to', async () => {
    const ops = fakeOps([]);
    const onClaimingStarterCards = vi.fn();

    const result = await setupConnectedWallet(WALLET, NODE, ME, ops as never, { log: () => {}, onClaimingStarterCards });

    expect(onClaimingStarterCards).toHaveBeenCalled();
    expect(onClaimingStarterCards.mock.invocationCallOrder[0]).toBeLessThan(ops.sendMintStarterCards.mock.invocationCallOrder[0]);
    // The mint's own messages are handed to the wallet, as for the in-browser wallet.
    expect(ops.receiveCardMessages).toHaveBeenCalledWith(ME, '0xTX', [{ m: 1 }]);
    expect(localStorage.getItem(MINTED_KEY)).toBe('true');
    expect(result.ownedCardIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves how the claim pays to the wallet: it reads no Fee Juice balance first', async () => {
    // Nulo can pay from the account's Fee Juice or through its network's
    // sponsor, so an empty balance is no reason to hold the claim back.
    const node = { getPublicStorageAt: vi.fn() };
    const ops = fakeOps([]);

    await setupConnectedWallet(WALLET, node, ME, ops as never, { log: () => {} });

    expect(ops.sendMintStarterCards).toHaveBeenCalled();
    expect(node.getPublicStorageAt).not.toHaveBeenCalled();
  });

  it('treats a claim the contract refuses as already made, so the account is out of cards, not broken', async () => {
    const ops = fakeOps([]);
    ops.sendMintStarterCards.mockRejectedValue(new Error('Simulation failed: Existing nullifier'));

    const result = await setupConnectedWallet(WALLET, NODE, ME, ops as never, { log: () => {} });

    expect(result.ownedCardIds).toEqual([]);
    expect(localStorage.getItem(MINTED_KEY)).toBe('true');
  });

  it('surfaces any other failure of the claim, such as the player declining it in the wallet', async () => {
    const ops = fakeOps([]);
    ops.sendMintStarterCards.mockRejectedValue(new Error('User rejected the transaction'));

    await expect(setupConnectedWallet(WALLET, NODE, ME, ops as never, { log: () => {} }))
      .rejects.toThrow(/User rejected/);
    expect(localStorage.getItem(MINTED_KEY)).toBeNull();
  });

  it('does not claim twice for an account this browser already claimed for', async () => {
    localStorage.setItem(MINTED_KEY, 'true');
    const ops = fakeOps([]);

    await setupConnectedWallet(WALLET, NODE, ME, ops as never, { log: () => {} });

    expect(ops.sendMintStarterCards).not.toHaveBeenCalled();
  });
});
