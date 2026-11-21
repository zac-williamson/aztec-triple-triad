/**
 * The starter cards' last onboarding step: persist them to the card store (the
 * boot-time restore's record), then hand the mint's offchain messages to the
 * PXE. The messages exist only in memory, so a store that fails must never
 * cost the receive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  fetchTxEffectData: vi.fn(),
  addCards: vi.fn(),
}));

vi.mock('./noteImporter', () => ({
  fetchTxEffectData: h.fetchTxEffectData,
  getNftArtifact: vi.fn(),
}));
vi.mock('./cardStore', () => ({
  addCards: h.addCards,
  loadCards: vi.fn(() => []),
  saveCards: vi.fn(),
}));

import { storeAndReceiveStarterCards } from './connectToAztec';

const MESSAGES = [{ m: 1 }, { m: 2 }, { m: 3 }, { m: 4 }, { m: 5 }];

function fakeOps() {
  return {
    computeNoteRandomness: vi.fn().mockResolvedValue(['0xr0', '0xr1', '0xr2', '0xr3', '0xr4']),
    receiveCardMessages: vi.fn().mockResolvedValue(5),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('storeAndReceiveStarterCards', () => {
  it('stores the five starter cards, then receives the mint\'s own messages', async () => {
    h.fetchTxEffectData.mockResolvedValue({ noteHashes: ['0xh'], firstNullifier: '0xn' });
    const ops = fakeOps();

    await storeAndReceiveStarterCards(ops as never, {}, '0xME', '0xTX', MESSAGES as never, () => {});

    expect(h.addCards).toHaveBeenCalledWith('0xME', [1, 2, 3, 4, 5].map((cardId, i) => ({
      cardId, randomness: `0xr${i}`, txHash: '0xTX', noteHashes: ['0xh'], firstNullifier: '0xn',
    })));
    expect(ops.receiveCardMessages).toHaveBeenCalledWith('0xME', '0xTX', MESSAGES);
    expect(h.addCards.mock.invocationCallOrder[0])
      .toBeLessThan(ops.receiveCardMessages.mock.invocationCallOrder[0]);
  });

  it('still receives the cards when storing them throws', async () => {
    h.fetchTxEffectData.mockRejectedValue(new Error('node unreachable'));
    const ops = fakeOps();

    await storeAndReceiveStarterCards(ops as never, {}, '0xME', '0xTX', MESSAGES as never, () => {});

    expect(h.addCards).not.toHaveBeenCalled();
    expect(ops.receiveCardMessages).toHaveBeenCalledWith('0xME', '0xTX', MESSAGES);
  });

  it('still receives the cards when the node never serves the tx effect', async () => {
    h.fetchTxEffectData.mockResolvedValue(null);
    const ops = fakeOps();
    const log = vi.fn();

    await storeAndReceiveStarterCards(ops as never, {}, '0xME', '0xTX', MESSAGES as never, log);

    expect(h.addCards).not.toHaveBeenCalled();
    expect(ops.receiveCardMessages).toHaveBeenCalledWith('0xME', '0xTX', MESSAGES);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not stored for restore'));
  });
});
