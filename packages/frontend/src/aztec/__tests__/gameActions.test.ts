/**
 * The private-game actions: commit, settle, import, cancel, claim, contest,
 * finalize. The PXE door, the node reads and the card store are mocked; what
 * is pinned is the protocol — what each action sends, in which order, and
 * which of the player's OWN notes each kind of resolution imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  ops: {} as Record<string, any>,
  runPxeTx: vi.fn(),
  fetchTxEffectData: vi.fn(),
  addCards: vi.fn(),
  readGameChainState: vi.fn(),
  blockTimestamp: vi.fn(),
  findTxWithNullifier: vi.fn(),
  releasedPreparedNotes: vi.fn(),
  waitForNullifier: vi.fn(),
  buildSettleGameArgs: vi.fn(),
  waitForAbandonBar: vi.fn(),
  waitForDisputeWindow: vi.fn(),
}));

vi.mock('../pxe', () => ({ runPxeTx: h.runPxeTx, pxe: h.ops }));
vi.mock('../noteImporter', () => ({ fetchTxEffectData: h.fetchTxEffectData }));
vi.mock('../cardStore', () => ({ addCards: h.addCards }));
vi.mock('../config', () => ({ AZTEC_CONFIG: { nftContractAddress: '0xNFT', tokenContractAddress: '0xTOKEN' } }));
vi.mock('../gameChain', () => ({
  readGameChainState: h.readGameChainState,
  blockTimestamp: h.blockTimestamp,
  findTxWithNullifier: h.findTxWithNullifier,
  releasedPreparedNotes: h.releasedPreparedNotes,
  waitForNullifier: h.waitForNullifier,
}));
vi.mock('../settlementArgs', () => ({
  buildSettleGameArgs: h.buildSettleGameArgs,
  waitForAbandonBar: h.waitForAbandonBar,
  waitForDisputeWindow: h.waitForDisputeWindow,
  DISPUTE_SECONDS: 600,
  MIN_ABANDON_SECONDS: 480,
}));
vi.mock('../proofWorker', () => ({ circuitVerificationKey: vi.fn(async () => new Uint8Array([7, 7])) }));

import {
  announcedResolution,
  cancelGame,
  claimAbandonment,
  ClaimContestedError,
  clearGameActionCaches,
  contestClaim,
  createGameOnChain,
  finalizeAbandonment,
  importDiscoveredResolution,
  importResolution,
  joinGameOnChain,
  OpponentResumedError,
  planSettlement,
  settleGame,
  type PrivateGame,
} from '../gameActions';
import { GAME_NULLIFIER_COUNT, normalizeField, NULLIFIER_INDEX } from '../privateGame';
import { chainState, P1_HAND, P2_HAND, record, secrets, transcript } from './privateGameFixtures';

const KEY = normalizeField(0x6a3en);
const ctx = { owner: '0xME', node: { node: true } };
const NULLIFIERS = Array.from({ length: GAME_NULLIFIER_COUNT }, (_, i) => normalizeField(BigInt(0x900 + i)));
const EFFECT = { noteHashes: ['0xa', '0xb'], firstNullifier: '0xf' };
const GAME_P1: PrivateGame = { roomId: 'room-1', role: 1, hand: P1_HAND, gameKey: KEY, nonce: '0x28', record1: record(1), record2: record(2) };
const GAME_P2: PrivateGame = { ...GAME_P1, role: 2, hand: P2_HAND };
const S = secrets(3);

beforeEach(() => {
  vi.clearAllMocks();
  clearGameActionCaches();
  for (const k of Object.keys(h.ops)) delete h.ops[k];
  Object.assign(h.ops, {
    readNoteNonce: vi.fn(async () => '0x28'),
    computeGameSecrets: vi.fn(async () => S),
    previewRecord: vi.fn(async () => record(9)),
    gameNullifiers: vi.fn(async () => NULLIFIERS),
    sendCreateGame: vi.fn(async () => '0xCREATE'),
    sendJoinGame: vi.fn(async () => '0xJOIN'),
    sendSettleGame: vi.fn(async () => '0xSETTLE'),
    sendCancelGame: vi.fn(async () => '0xCANCEL'),
    sendClaimAbandonedGame: vi.fn(async () => '0xCLAIM'),
    sendContestAbandonment: vi.fn(async () => '0xCONTEST'),
    sendFinalizeAbandonedGame: vi.fn(async () => '0xFINAL'),
    importCardNotes: vi.fn(async (_o: string, _t: string, notes: { tokenId: number }[]) => notes.map(n => n.tokenId)),
    importTokenRewardNote: vi.fn(async () => true),
  });
  h.runPxeTx.mockImplementation(async (o: any) => {
    const result = await o.execute(h.ops, () => {});
    if (o.postEffects) await o.postEffects(result, h.ops);
    return result;
  });
  h.fetchTxEffectData.mockResolvedValue(EFFECT);
  h.waitForAbandonBar.mockResolvedValue(undefined);
  h.waitForDisputeWindow.mockResolvedValue(undefined);
  h.buildSettleGameArgs.mockResolvedValue(['ARGS']);
});

describe('commit', () => {
  it('create: nonce → secrets → record preview → nullifiers, persisted BEFORE the send', async () => {
    const order: string[] = [];
    h.ops.sendCreateGame.mockImplementation(async () => { order.push('send'); return '0xCREATE'; });
    const onPrepared = vi.fn(() => order.push('prepared'));

    const out = await createGameOnChain(ctx, { roomId: 'room-1', gameKey: KEY, hand: P1_HAND, onPrepared });

    expect(h.ops.previewRecord).toHaveBeenCalledWith('0xME', KEY, P1_HAND, '0x28');
    expect(h.ops.computeGameSecrets).toHaveBeenCalledWith('0xME', '0x28');
    expect(h.ops.gameNullifiers).toHaveBeenCalledWith('0xME', KEY, record(9), null);
    expect(h.ops.sendCreateGame).toHaveBeenCalledWith('0xME', KEY, P1_HAND, expect.objectContaining({ node: ctx.node }));
    expect(onPrepared).toHaveBeenCalledWith({ nonce: '0x28', record: record(9) });
    expect(order).toEqual(['prepared', 'send']);
    expect(out).toEqual({ nonce: '0x28', record: record(9), secrets: S, nullifiers: NULLIFIERS, txHash: '0xCREATE' });
    expect(h.runPxeTx.mock.calls[0][0]).toMatchObject({ type: 'create_game', gameId: 'room-1' });
  });

  it('join: the joiner\'s record and nullifiers include the creator\'s record', async () => {
    const out = await joinGameOnChain(ctx, { roomId: 'room-1', gameKey: KEY, hand: P2_HAND, record1: record(1) });
    expect(h.ops.gameNullifiers).toHaveBeenCalledWith('0xME', KEY, record(1), record(9));
    expect(h.ops.sendJoinGame).toHaveBeenCalledWith('0xME', KEY, record(1), P2_HAND, expect.anything());
    expect(out.record).toEqual(record(9));
  });
});

describe('settlement plan', () => {
  it('maps the winner\'s pick to the loser\'s move, with its slot', () => {
    const plan = planSettlement(transcript({ winner: 1 }), P2_HAND[2]);
    expect(plan).toEqual({ winner: 1, prizeMove: 5, prize: { cardId: P2_HAND[2], slot: 2 } });
  });

  it('a draw has no prize (prize_move 0 is ignored by the contract)', () => {
    expect(planSettlement(transcript({ winner: 3 }), null)).toEqual({ winner: 'draw', prizeMove: 0, prize: null });
  });

  it('without a pick, takes one of the loser\'s placed cards', () => {
    const plan = planSettlement(transcript({ winner: 2 }), null);
    expect(plan.prizeMove % 2).toBe(0);
    expect(P1_HAND).toContain(plan.prize!.cardId);
  });

  it('refuses the winner\'s own card', () => {
    expect(() => planSettlement(transcript({ winner: 1 }), P1_HAND[0])).toThrow(/not placed by the loser/);
  });
});

describe('settle', () => {
  it('builds settle_game from both records, the transcript and the prize move, and sends it', async () => {
    const moveProofs = transcript({ winner: 1 });
    const phases: string[] = [];
    const txHash = await settleGame(GAME_P1, ctx, { moveProofs, prizeMove: 5, onPhase: p => phases.push(p) });

    expect(txHash).toBe('0xSETTLE');
    expect(h.buildSettleGameArgs).toHaveBeenCalledWith(expect.objectContaining({
      gameKey: KEY, record1: record(1), record2: record(2), moveProofs, prizeMove: 5, moveVk: new Uint8Array([7, 7]),
    }));
    expect(h.ops.sendSettleGame).toHaveBeenCalledWith('0xME', ['ARGS'], expect.objectContaining({ timeoutMs: 600 }));
    expect(phases).toEqual(['proving', 'sending']);
  });

  it('refuses before the join, or without all nine moves', async () => {
    await expect(settleGame({ ...GAME_P1, record2: null }, ctx, { moveProofs: transcript({ winner: 1 }), prizeMove: 1 }))
      .rejects.toThrow(/nobody has joined/);
    await expect(settleGame(GAME_P1, ctx, { moveProofs: transcript({ winner: 1 }).slice(0, 8), prizeMove: 1 }))
      .rejects.toThrow(/all 9 move proofs/);
    expect(h.ops.sendSettleGame).not.toHaveBeenCalled();
  });
});

describe('import — only our own notes, with our own data', () => {
  const imported = () => (h.ops.importCardNotes.mock.calls[0]?.[2] ?? []) as { tokenId: number; randomness: string }[];

  it('winner: five returns, the prize with the prize randomness, the reward', async () => {
    const r = await importResolution(GAME_P1, ctx, {
      txHash: '0xSETTLE',
      resolution: { kind: 'settled', winner: 1, prize: { cardId: P2_HAND[2], slot: 2 } },
    });
    expect(imported()).toEqual([
      ...P1_HAND.map((id, i) => ({ tokenId: id, randomness: S.returns[i] })),
      { tokenId: P2_HAND[2], randomness: S.prize },
    ]);
    expect(h.ops.importTokenRewardNote).toHaveBeenCalledWith('0xME', '0xSETTLE', 20, S.reward, EFFECT);
    expect(h.addCards).toHaveBeenCalledWith('0xME', expect.arrayContaining([
      expect.objectContaining({ cardId: P2_HAND[2], randomness: S.prize, txHash: '0xSETTLE', noteHashes: EFFECT.noteHashes }),
    ]));
    expect(r.importedCardIds).toHaveLength(6);
    expect(r.takenCardId).toBeNull();
  });

  it('loser: the four returns that were not taken, and the reward', async () => {
    h.releasedPreparedNotes.mockResolvedValue({ returns: [true, true, true, false, true], reward: true });
    const r = await importResolution(GAME_P2, ctx, {
      txHash: '0xSETTLE',
      resolution: { kind: 'settled', winner: 1, prize: { cardId: P2_HAND[3], slot: 3 } },
    });
    expect(imported().map(n => n.tokenId)).toEqual([P2_HAND[0], P2_HAND[1], P2_HAND[2], P2_HAND[4]]);
    expect(imported().map(n => n.randomness)).toEqual([S.returns[0], S.returns[1], S.returns[2], S.returns[4]]);
    expect(h.ops.importTokenRewardNote).toHaveBeenCalledTimes(1);
    expect(r.takenCardId).toBe(P2_HAND[3]);
  });

  it('loser: the chain, not the settler, says which return was withheld', async () => {
    // The settler named slot 3; the tx actually withheld slot 1.
    h.releasedPreparedNotes.mockResolvedValue({ returns: [true, false, true, true, true], reward: true });
    const r = await importResolution(GAME_P2, ctx, {
      txHash: '0xSETTLE',
      resolution: { kind: 'settled', winner: 1, prize: { cardId: P2_HAND[3], slot: 3 } },
    });
    expect(imported().map(n => n.tokenId)).toEqual([P2_HAND[0], P2_HAND[2], P2_HAND[3], P2_HAND[4]]);
    expect(r.takenCardId).toBe(P2_HAND[1]);
    expect(h.releasedPreparedNotes).toHaveBeenCalledWith(EFFECT, record(2), { nft: '0xNFT', token: '0xTOKEN' });
  });

  it('draw: five returns and the reward, nothing else', async () => {
    await importResolution(GAME_P2, ctx, { txHash: '0xS', resolution: { kind: 'settled', winner: 'draw' } });
    expect(imported().map(n => n.tokenId)).toEqual(P2_HAND);
    expect(h.ops.importTokenRewardNote).toHaveBeenCalledTimes(1);
  });

  it('unwind: five returns, no reward', async () => {
    await importResolution(GAME_P2, ctx, { txHash: '0xF', resolution: { kind: 'unwound' } });
    expect(imported().map(n => n.tokenId)).toEqual(P2_HAND);
    expect(h.ops.importTokenRewardNote).not.toHaveBeenCalled();
  });

  it('cancel: the creator\'s five returns, no reward', async () => {
    await importResolution(GAME_P1, ctx, { txHash: '0xC', resolution: { kind: 'cancelled' } });
    expect(imported().map(n => n.tokenId)).toEqual(P1_HAND);
    expect(h.ops.importTokenRewardNote).not.toHaveBeenCalled();
  });

  it('nobody said what the tx was: it is read off our released notes', async () => {
    h.releasedPreparedNotes.mockResolvedValue({ returns: [true, true, true, true, true], reward: false });
    const r = await importResolution(GAME_P2, ctx, { txHash: '0xF' });
    expect(r.resolution).toEqual({ kind: 'unwound' });
    expect(imported()).toHaveLength(5);
  });

  it('a win whose prize nobody named: tries the loser\'s placed cards, stores none of the guesses', async () => {
    h.releasedPreparedNotes.mockResolvedValue({ returns: [true, true, true, true, true], reward: true });
    const r = await importResolution(GAME_P1, ctx, { txHash: '0xS', moveProofs: transcript({ winner: 1 }) });
    const prizes = imported().filter(n => n.randomness === S.prize).map(n => n.tokenId);
    expect(prizes).toEqual([P2_HAND[0], P2_HAND[1], P2_HAND[2], P2_HAND[3]]);
    expect(r.prizeUncertain).toBe(true);
    const stored = h.addCards.mock.calls[0][1] as { cardId: number }[];
    expect(stored.map(c => c.cardId)).toEqual(P1_HAND);
  });

  it('fails loudly when the node does not have the tx yet', async () => {
    h.fetchTxEffectData.mockResolvedValue(null);
    await expect(importResolution(GAME_P1, ctx, { txHash: '0xS', resolution: { kind: 'unwound' } })).rejects.toThrow(/does not have tx/);
    expect(h.ops.importCardNotes).not.toHaveBeenCalled();
  });

  it('derives our secrets once per nonce', async () => {
    await importResolution(GAME_P1, ctx, { txHash: '0x1', resolution: { kind: 'unwound' } });
    await importResolution(GAME_P1, ctx, { txHash: '0x2', resolution: { kind: 'unwound' } });
    expect(h.ops.computeGameSecrets).toHaveBeenCalledTimes(1);
  });
});

describe('finding the resolution from `done`', () => {
  it('is null while the game is unresolved', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 1, joined: 2 }));
    expect(await importDiscoveredResolution(GAME_P2, ctx)).toBeNull();
  });

  it('finds the tx carrying `done` in its block and imports from it', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 1, joined: 2, done: 88 }));
    h.findTxWithNullifier.mockResolvedValue({ txHash: '0xDONE', ...EFFECT });
    h.releasedPreparedNotes.mockResolvedValue({ returns: [true, true, false, true, true], reward: true });

    const r = await importDiscoveredResolution(GAME_P2, ctx);

    expect(h.findTxWithNullifier).toHaveBeenCalledWith(ctx.node, 88, NULLIFIERS[NULLIFIER_INDEX.done]);
    expect(h.fetchTxEffectData).not.toHaveBeenCalled(); // the block already carried the effects
    expect(r!.txHash).toBe('0xDONE');
    expect(r!.takenCardId).toBe(P2_HAND[2]);
  });

  it('falls back to what the settler announced when the tx cannot be read', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 1, joined: 2, done: 88 }));
    h.findTxWithNullifier.mockResolvedValue({ txHash: '0xDONE', ...EFFECT });
    h.releasedPreparedNotes.mockRejectedValue(new Error('hashing unavailable'));
    const moveProofs = transcript({ winner: 1 });
    const fallback = announcedResolution(moveProofs, 3);
    expect(fallback).toEqual({ kind: 'settled', winner: 1, prize: { cardId: P2_HAND[1], slot: 1 } });

    const r = await importDiscoveredResolution(GAME_P2, ctx, { moveProofs, fallback });

    expect(r!.takenCardId).toBe(P2_HAND[1]);
  });
});

describe('cancel', () => {
  it('cancels a game nobody joined and imports the creator\'s five', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 3 }));
    const r = await cancelGame({ ...GAME_P1, record2: null }, ctx);
    expect(h.ops.sendCancelGame).toHaveBeenCalledWith('0xME', KEY, record(1), expect.anything());
    expect(r.resolution).toEqual({ kind: 'cancelled' });
    expect(r.importedCardIds).toEqual(P1_HAND);
  });

  it('refuses once anyone joined, for a joiner, and for a game that never landed', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, seat2: 4 }));
    await expect(cancelGame(GAME_P1, ctx)).rejects.toThrow(/joined/);
    await expect(cancelGame(GAME_P2, ctx)).rejects.toThrow(/only the creator/);
    h.readGameChainState.mockResolvedValue(chainState({}));
    await expect(cancelGame(GAME_P1, ctx)).rejects.toThrow(/never created/);
    expect(h.ops.sendCancelGame).not.toHaveBeenCalled();
  });
});

describe('abandonment', () => {
  it('claim: waits for the bar from the join\'s block, then claims as our side with that block', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, seat2: 4, joined: 4 }));
    h.blockTimestamp.mockResolvedValue(5000);
    h.waitForNullifier.mockResolvedValue({ blockNumber: 61 });

    const claim = await claimAbandonment(GAME_P2, ctx);

    expect(h.blockTimestamp).toHaveBeenCalledWith(ctx.node, 4);
    expect(h.waitForAbandonBar).toHaveBeenCalledWith(ctx.node, 5000, expect.anything());
    expect(h.ops.sendClaimAbandonedGame).toHaveBeenCalledWith(
      '0xME', { gameKey: KEY, record1: record(1), record2: record(2) }, { side: 2, claimNo: 1, clockBlock: 4 }, expect.anything());
    expect(h.waitForNullifier.mock.calls[0][1]).toBe(NULLIFIERS[NULLIFIER_INDEX.claim(1, 2)]);
    expect(claim).toEqual({ claimNo: 1, claimSide: 2, claimBlock: 61 });
  });

  it('claim 2 counts from the contest of claim 1', async () => {
    h.readGameChainState.mockResolvedValue(chainState({
      created: 3, seat2: 4, joined: 4, claimSlots: [20], claims: [[20, null]], contests: [30], resolved: [30], contestedBy: [null, 30],
    }));
    h.blockTimestamp.mockResolvedValue(9000);
    h.waitForNullifier.mockResolvedValue({ blockNumber: 70 });
    await claimAbandonment(GAME_P2, ctx);
    expect(h.ops.sendClaimAbandonedGame.mock.calls[0][2]).toEqual({ side: 2, claimNo: 2, clockBlock: 30 });
  });

  it('stands down when the opponent moves during the wait — no claim is filed', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, seat2: 4, joined: 4 }));
    h.blockTimestamp.mockResolvedValue(5000);
    h.waitForAbandonBar.mockImplementation(async (_n: unknown, _t: number, o: { onProgress: (s: number) => void }) => o.onProgress(100));
    await expect(claimAbandonment(GAME_P2, ctx, { shouldStop: () => true })).rejects.toBeInstanceOf(OpponentResumedError);
    expect(h.ops.sendClaimAbandonedGame).not.toHaveBeenCalled();
  });

  it('a claim already standing is returned, not duplicated', async () => {
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, seat2: 4, joined: 4, claimSlots: [20], claims: [[20, null]] }));
    expect(await claimAbandonment(GAME_P2, ctx)).toEqual({ kind: 'open-claim', claimNo: 1, claimSide: 1, claimBlock: 20 });
    expect(h.ops.sendClaimAbandonedGame).not.toHaveBeenCalled();
  });

  it('finalize: waits out the window from the claim\'s block, then unwinds and imports our five', async () => {
    h.blockTimestamp.mockResolvedValue(7000);
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, joined: 4, claimSlots: [20], claims: [[null, 20]] }));
    const claim = { claimNo: 1 as const, claimSide: 2 as const, claimBlock: 20 };

    const r = await finalizeAbandonment(GAME_P2, ctx, claim);

    expect(h.waitForDisputeWindow).toHaveBeenCalledWith(ctx.node, 7000, expect.anything());
    expect(h.ops.sendFinalizeAbandonedGame).toHaveBeenCalledWith('0xME', expect.anything(), claim, expect.anything());
    expect(r!.resolution).toEqual({ kind: 'unwound' });
    expect(h.ops.importTokenRewardNote).not.toHaveBeenCalled();
  });

  it('finalize stops on a contested claim, and steps aside for a game resolved another way', async () => {
    const claim = { claimNo: 1 as const, claimSide: 2 as const, claimBlock: 20 };
    h.blockTimestamp.mockResolvedValue(7000);
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, joined: 4, claimSlots: [20], claims: [[null, 20]], resolved: [25], contests: [25] }));
    await expect(finalizeAbandonment(GAME_P2, ctx, claim)).rejects.toBeInstanceOf(ClaimContestedError);
    h.readGameChainState.mockResolvedValue(chainState({ created: 3, joined: 4, done: 30 }));
    expect(await finalizeAbandonment(GAME_P2, ctx, claim)).toBeNull();
    expect(h.ops.sendFinalizeAbandonedGame).not.toHaveBeenCalled();
  });

  it('contest: as our side, against their claim, anchored to the block before it', async () => {
    await contestClaim(GAME_P1, ctx, { claimNo: 2, claimSide: 2, claimBlock: 90 });
    expect(h.ops.sendContestAbandonment).toHaveBeenCalledWith(
      '0xME', expect.anything(), { side: 1, claimNo: 2, claimSide: 2, beforeClaimBlock: 89 }, expect.anything());
    await expect(contestClaim(GAME_P1, ctx, { claimNo: 1, claimSide: 1, claimBlock: 5 })).rejects.toThrow(/own claim/);
  });
});
