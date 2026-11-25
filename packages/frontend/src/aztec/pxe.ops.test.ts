/**
 * pxe.ts named ops — the contract-call shape behind the single door. These pin:
 *  - every game send routes through the queue AND carries base-fee headroom,
 *    with the exact argument layout of the private-games contract;
 *  - reads return decimal-safe processed VALUES (records, secrets,
 *    nullifiers), never a contract;
 *  - imports inject one note per import_note, the reward with the player's
 *    OWN reward randomness;
 *  - `contractCache` is NOT exported — a raw contract cannot escape the door.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enqueuePxe: vi.fn(),
  ensureContracts: vi.fn(),
  waitForWarmup: vi.fn(),
  gasSettingsWithHeadroom: vi.fn(),
}));

vi.mock('./txManager', () => ({ default: { enqueuePxe: h.enqueuePxe, runTx: vi.fn() } }));
vi.mock('./contracts', () => ({
  ensureContracts: h.ensureContracts,
  waitForWarmup: h.waitForWarmup,
  warmupContracts: vi.fn(),
}));
vi.mock('./feeSettings', () => ({ gasSettingsWithHeadroom: h.gasSettingsWithHeadroom }));
vi.mock('./fieldUtils', () => ({
  toFr: (_Fr: any, v: any) => v,
  toHexString: (v: any) => '0x' + String(v),
}));

import { pxe, setPxeWallet } from './pxe';
import { normalizeField, ZERO_RECORD } from './privateGame';
import { record } from './__tests__/privateGameFixtures';

class FakeFr {
  constructor(public v: any) {}
  toString() { return String(this.v); }
}
const AztecAddress = { fromStringUnsafe: (s: string) => ({ __addr: s }) };
const sim = (result: any) => ({ simulate: vi.fn().mockResolvedValue({ result }) });
const mined = (hash: string, extra: Record<string, unknown> = {}) =>
  vi.fn().mockResolvedValue({ receipt: { txHash: { toString: () => hash } }, ...extra });
const KEY = normalizeField(0x6a3en);
const HAND = [1, 2, 3, 4, 5];

beforeEach(() => {
  vi.clearAllMocks();
  setPxeWallet({ id: 'wallet' });
  h.waitForWarmup.mockResolvedValue(undefined);
  h.enqueuePxe.mockImplementation((fn: () => Promise<unknown>) => fn()); // passthrough queue
  h.gasSettingsWithHeadroom.mockResolvedValue({ maxFeesPerGas: 'HEADROOM' });
});

function gameWith(methods: Record<string, unknown>) {
  h.ensureContracts.mockResolvedValue({ gameContract: { methods }, nftContract: { methods: {} }, Fr: FakeFr, AztecAddress });
}

describe('pxe game sends — enqueue + base-fee headroom, contract stays inside', () => {
  it('sendCreateGame sends create_game(game_key, card_ids) with headroom and a 15s receipt poll', async () => {
    const send = mined('0xTX');
    const create_game = vi.fn(() => ({ send }));
    gameWith({ create_game });

    const txHash = await pxe.sendCreateGame('0xME', KEY, HAND, { node: {}, timeoutMs: 123 });

    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    const [key, ids] = create_game.mock.calls[0] as unknown as [string, FakeFr[]];
    expect(key).toBe(KEY);
    expect(ids.map(f => f.v)).toEqual(HAND.map(BigInt));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { __addr: '0xME' },
      fee: { gasSettings: { maxFeesPerGas: 'HEADROOM' } },
      // interval:15 — poll getTxReceipt every 15s, not the SDK's 1s default
      // (testnet txs mine in minutes; cuts receipt-poll request volume).
      wait: { timeout: 123, interval: 15 },
    }));
    expect(txHash).toBe('0xTX');
  });

  it('refuses a hand that is not five cards — it would commit the wrong hand', async () => {
    gameWith({ create_game: vi.fn() });
    await expect(pxe.sendCreateGame('0xME', KEY, [1, 2], { node: {}, timeoutMs: 1 })).rejects.toThrow(/exactly 5 card ids/);
  });

  it('sendJoinGame sends join_game(game_key, record_1, card_ids)', async () => {
    const join_game = vi.fn(() => ({ send: mined('0xJN') }));
    gameWith({ join_game });

    expect(await pxe.sendJoinGame('0xME', KEY, record(1), HAND, { node: {}, timeoutMs: 9 })).toBe('0xJN');
    const [key, r1, ids] = join_game.mock.calls[0] as unknown as [string, string[], FakeFr[]];
    expect(key).toBe(KEY);
    expect(r1).toEqual(record(1));
    expect(ids).toHaveLength(5);
  });

  it('sendSettleGame spreads the ordered settle_game args, with headroom', async () => {
    const send = mined('0xST');
    const settle_game = vi.fn(() => ({ send }));
    gameWith({ settle_game });

    expect(await pxe.sendSettleGame('0xME', ['a', 'b', 'c'], { node: {}, timeoutMs: 9 })).toBe('0xST');
    expect(settle_game).toHaveBeenCalledWith('a', 'b', 'c');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ fee: { gasSettings: { maxFeesPerGas: 'HEADROOM' } } }));
  });

  it('sendCancelGame sends cancel_game(game_key, record_1)', async () => {
    const cancel_game = vi.fn(() => ({ send: mined('0xCG') }));
    gameWith({ cancel_game });

    expect(await pxe.sendCancelGame('0xME', KEY, record(1), { node: {}, timeoutMs: 9 })).toBe('0xCG');
    expect(cancel_game).toHaveBeenCalledWith(KEY, record(1));
  });

  it('refuses a record that is not nine fields', async () => {
    gameWith({ cancel_game: vi.fn() });
    await expect(pxe.sendCancelGame('0xME', KEY, record(1).slice(0, 8), { node: {}, timeoutMs: 9 })).rejects.toThrow(/9 fields/);
  });

  it('sendClaimAbandonedGame: (key, r1, r2, side, claim_no, clock_block, hand_vk, open_proof, open_inputs, forfeit_slot)', async () => {
    const claim_abandoned_game = vi.fn(() => ({ send: mined('0xCL') }));
    gameWith({ claim_abandoned_game });
    const ref = { gameKey: KEY, record1: record(1), record2: record(2) };
    const forfeit = [['vk'], ['proof'], ['inputs'], 'slot'];

    await pxe.sendClaimAbandonedGame('0xME', ref, { side: 2, claimNo: 1, clockBlock: 77 }, forfeit, { node: {}, timeoutMs: 9 });

    const args = claim_abandoned_game.mock.calls[0] as unknown as any[];
    expect(args[0]).toBe(KEY);
    expect(args[1]).toEqual(record(1));
    expect(args[2]).toEqual(record(2));
    expect(args[3].v).toBe(2n);
    expect(args[4].v).toBe(1n);
    expect(args[5]).toBe(77); // u32: a plain number
    expect(args.slice(6)).toEqual(forfeit); // the forfeit tail, as buildClaimForfeitArgs built it
  });

  it('sendClaimAbandonedGame refuses a forfeit tail that is not four arguments', async () => {
    gameWith({ claim_abandoned_game: vi.fn() });
    const ref = { gameKey: KEY, record1: record(1), record2: record(2) };
    await expect(pxe.sendClaimAbandonedGame('0xME', ref, { side: 2, claimNo: 1, clockBlock: 77 }, ['vk'], { node: {}, timeoutMs: 9 }))
      .rejects.toThrow(/4 arguments/);
  });

  it('sendContestAbandonment: (key, r1, r2, side, claim_no, claim_side, before_claim_block)', async () => {
    const contest_abandonment = vi.fn(() => ({ send: mined('0xCT') }));
    gameWith({ contest_abandonment });
    const ref = { gameKey: KEY, record1: record(1), record2: record(2) };

    await pxe.sendContestAbandonment('0xME', ref, { side: 1, claimNo: 2, claimSide: 2, beforeClaimBlock: 99 }, { node: {}, timeoutMs: 9 });

    const args = contest_abandonment.mock.calls[0] as unknown as any[];
    expect([args[3].v, args[4].v, args[5].v, args[6]]).toEqual([1n, 2n, 2n, 99]);
  });

  it('sendFinalizeAbandonedGame: (key, r1, r2, claim_no, claim_side, claim_block, forfeit_slot, forfeit_card)', async () => {
    const finalize_abandoned_game = vi.fn(() => ({ send: mined('0xFN') }));
    gameWith({ finalize_abandoned_game });
    const ref = { gameKey: KEY, record1: record(1), record2: record(2) };

    await pxe.sendFinalizeAbandonedGame('0xME', ref, { claimNo: 3, claimSide: 1, claimBlock: 150 }, { slot: 2, cardId: 41 }, { node: {}, timeoutMs: 9 });

    const args = finalize_abandoned_game.mock.calls[0] as unknown as any[];
    expect([args[3].v, args[4].v, args[5], args[6].v, args[7].v]).toEqual([3n, 1n, 150, 2n, 41n]);
  });

  it('forfeitNullifiers: the four terms a claim could have, from the contract', async () => {
    const forfeit_nullifiers = vi.fn(() => sim([1n, 2n, 3n, 4n]));
    gameWith({ forfeit_nullifiers });
    const out = await pxe.forfeitNullifiers('0xME', KEY, record(1), 2, 1, [7, 8, 9]);
    expect(out).toEqual([1n, 2n, 3n, 4n].map(normalizeField));
    const args = forfeit_nullifiers.mock.calls[0] as unknown as any[];
    expect(args[0]).toBe(KEY);
    expect(args[1]).toEqual(record(1));
    expect([args[2].v, args[3].v, args[4].map((f: any) => f.v)]).toEqual([2n, 1n, [7n, 8n, 9n]]);
  });

  it('refuses a block number a u32 cannot hold', async () => {
    gameWith({ claim_abandoned_game: vi.fn() });
    const ref = { gameKey: KEY, record1: record(1), record2: record(2) };
    await expect(pxe.sendClaimAbandonedGame('0xME', ref, { side: 1, claimNo: 1, clockBlock: -1 }, [1, 2, 3, 4], { node: {}, timeoutMs: 9 }))
      .rejects.toThrow(/not a block number/);
  });

  it('throws (no silent null) when a send returns no txHash', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: { txHash: null } });
    gameWith({ create_game: () => ({ send }) });
    await expect(pxe.sendCreateGame('0xME', KEY, HAND, { node: {}, timeoutMs: 1 })).rejects.toThrow(/no txHash/);
  });
});

describe('pxe game reads — processed values out, never a contract', () => {
  it('readNoteNonce normalises the decimal simulate result', async () => {
    h.ensureContracts.mockResolvedValue({ nftContract: { methods: { get_note_nonce: () => sim(40n) } }, Fr: FakeFr, AztecAddress });
    expect(await pxe.readNoteNonce('0xME')).toBe(normalizeField(40n));
    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
  });

  it('computeGameSecrets reads [blinding, r_0..r_4, prize, reward] at the given nonce', async () => {
    const compute_game_secrets = vi.fn(() => sim(['10', '20', '21', '22', '23', '24', '30', '40']));
    h.ensureContracts.mockResolvedValue({ nftContract: { methods: { compute_game_secrets } }, Fr: FakeFr, AztecAddress });

    const s = await pxe.computeGameSecrets('0xME', '0x28');

    expect(compute_game_secrets).toHaveBeenCalledWith('0x28');
    expect(s.blinding).toBe(normalizeField(10n));
    expect(s.returns[4]).toBe(normalizeField(24n));
    expect(s.reward).toBe(normalizeField(40n));
  });

  it('previewRecord builds the record create/join will commit, at our nonce', async () => {
    const preview_record = vi.fn(() => sim(record(3).map(v => BigInt(v).toString())));
    gameWith({ preview_record });

    const r = await pxe.previewRecord('0xME', KEY, HAND, '0x28');

    const [key, ids, nonce] = preview_record.mock.calls[0] as unknown as [string, FakeFr[], string];
    expect(key).toBe(KEY);
    expect(ids).toHaveLength(5);
    expect(nonce).toBe('0x28');
    expect(r).toEqual(record(3));
  });

  it('gameNullifiers passes a zero record_2 before a join, and returns 21 siloed nullifiers', async () => {
    const out = Array.from({ length: 21 }, (_, i) => String(1000 + i));
    const game_nullifiers = vi.fn(() => sim(out));
    gameWith({ game_nullifiers });

    const n = await pxe.gameNullifiers('0xME', KEY, record(1), null);

    expect(game_nullifiers).toHaveBeenCalledWith(KEY, record(1), ZERO_RECORD);
    expect(n).toHaveLength(21);
    expect(n[0]).toBe(normalizeField(1000n));
  });

  it('refuses a nullifier list of the wrong length rather than misreading the game', async () => {
    gameWith({ game_nullifiers: () => sim(['1', '2']) });
    await expect(pxe.gameNullifiers('0xME', KEY, record(1), record(2))).rejects.toThrow(/expected 21/);
  });
});

describe('pxe card sends — offchain card messages', () => {
  function nftWith(send: ReturnType<typeof vi.fn>) {
    h.ensureContracts.mockResolvedValue({ nftContract: { methods: { purchase_card_pack: () => ({ send }) } }, Fr: FakeFr, AztecAddress });
  }

  it('gives card messages from a connected wallet the time of the block their tx landed in', async () => {
    // Nulo hands send() results back through the wallet-sdk's sendTx schema,
    // which drops each message's anchorBlockTimestamp; offchain_receive cannot
    // take a message without one.
    const offchainMessages = [{ recipient: 'me' }, { recipient: 'me', anchorBlockTimestamp: 3n }];
    nftWith(vi.fn().mockResolvedValue({ receipt: { txHash: { toString: () => '0xPK' }, blockNumber: 41 }, offchainMessages }));
    const node = { getBlockData: vi.fn(async () => ({ header: { globalVariables: { timestamp: 1_800_000_000n } } })) };

    const sent = await pxe.sendPurchaseCardPack('0xME', { node, timeoutMs: 9 });

    expect(node.getBlockData).toHaveBeenCalledWith(41);
    expect(sent.offchainMessages).toEqual([
      { recipient: 'me', anchorBlockTimestamp: 1_800_000_000n },
      { recipient: 'me', anchorBlockTimestamp: 3n },
    ]);
  });

  it('still returns a mined send whose block it cannot read, timing its messages from now', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: { txHash: { toString: () => '0xPK' }, blockNumber: 41 }, offchainMessages: [{ recipient: 'me' }] });
    nftWith(send);
    const node = { getBlockData: vi.fn(async () => { throw new Error('node down'); }) };
    const before = BigInt(Math.floor(Date.now() / 1000));

    const sent = await pxe.sendPurchaseCardPack('0xME', { node, timeoutMs: 9 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(sent.txHash).toBe('0xPK');
    expect(sent.offchainMessages[0].anchorBlockTimestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('pxe import ops — notes in', () => {
  it('receiveCardMessages hands only our own NFT messages to offchain_receive, 16 per call', async () => {
    const simulate = vi.fn().mockResolvedValue({ result: undefined });
    const offchain_receive = vi.fn((_batch: unknown[]) => ({ simulate }));
    const addr = (s: string) => ({ s, equals: (o: { s?: string } | undefined) => o?.s === s });
    h.ensureContracts.mockResolvedValue({
      nftContract: { address: addr('NFT'), methods: { offchain_receive } },
      Fr: FakeFr,
      AztecAddress: { fromStringUnsafe: (s: string) => addr(s) },
    });
    const msg = (recipient: string, contract: string, i: number) => ({
      recipient: addr(recipient), contractAddress: addr(contract), payload: [`c${i}`], anchorBlockTimestamp: 7n,
    });
    const messages = [
      ...Array.from({ length: 17 }, (_, i) => msg('0xME', 'NFT', i)),
      // A PXE can only process its own accounts' messages (the inbox is
      // scoped by recipient)...
      msg('0xOPP', 'NFT', 99),
      // ...and another contract's messages go to that contract, not the NFT.
      msg('0xME', 'TOKEN', 98),
    ];

    const received = await pxe.receiveCardMessages('0xME', '0xTX', messages as never);

    expect(received).toBe(17);
    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    // offchain_receive takes a BoundedVec of at most 16.
    expect(offchain_receive).toHaveBeenCalledTimes(2);
    const first = offchain_receive.mock.calls[0][0];
    expect(first).toHaveLength(16);
    expect(first[0]).toEqual({
      ciphertext: ['c0'], recipient: messages[0].recipient, tx_hash: '0xTX', anchor_block_timestamp: 7n,
    });
    expect(offchain_receive.mock.calls[1][0]).toHaveLength(1);
    expect(simulate).toHaveBeenCalledWith({ from: expect.objectContaining({ s: '0xME' }) });
  });

  it('importCardNotes injects one note per import_note, enqueued', async () => {
    const importSim = vi.fn().mockResolvedValue(undefined);
    const import_note = vi.fn(() => ({ simulate: importSim }));
    h.ensureContracts.mockResolvedValue({ nftContract: { methods: { import_note } }, Fr: FakeFr, AztecAddress });

    const ids = await pxe.importCardNotes(
      '0xME', '0xTX',
      [{ tokenId: 1, randomness: '0xr1' }, { tokenId: 2, randomness: '0xr2' }],
      'T', { noteHashes: ['0xh'], firstNullifier: '0xn' },
    );

    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    expect(import_note).toHaveBeenCalledTimes(2);
    expect(ids).toEqual([1, 2]);
  });

  it('importTokenRewardNote imports the reward with the player\'s own reward randomness', async () => {
    const importSim = vi.fn().mockResolvedValue(undefined);
    const import_note = vi.fn(() => ({ simulate: importSim }));
    h.ensureContracts.mockResolvedValue({ tokenContract: { methods: { import_note } }, Fr: FakeFr, AztecAddress });

    const ok = await pxe.importTokenRewardNote('0xME', '0xTX', 20, '0xU', { noteHashes: ['0xh1', '0xh2'], firstNullifier: '0xn' });

    expect(ok).toBe(true);
    const args = import_note.mock.calls[0] as unknown as any[];
    expect(args[1]).toBe(20n);      // the amount, as u128
    expect(args[2]).toBe('0xU');    // u, from our own compute_game_secrets
    expect(args[5]).toBe(2);        // note hashes in the tx
  });
});

describe('contracts module — contractCache stays private', () => {
  it('does NOT export contractCache (raw contracts cannot escape the door)', async () => {
    // importActual bypasses the ./contracts mock above to inspect the real module.
    const real = await vi.importActual<typeof import('./contracts')>('./contracts');
    expect((real as Record<string, unknown>).contractCache).toBeUndefined();
    // ensureContracts remains the door's internal accessor (pxe.ts + testkit only).
    expect(typeof (real as Record<string, unknown>).ensureContracts).toBe('function');
  });
});
