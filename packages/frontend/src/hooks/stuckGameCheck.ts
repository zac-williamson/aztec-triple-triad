/**
 * The menu's side of unfinished games: find the one that needs the player,
 * import whatever already resolved, and run the recovery the player picks.
 *
 * Not a hook — plain async functions over the stored records and the chain
 * actions, so useGame stays a thin facade and this can be tested directly.
 */
import {
  announcedResolution,
  cancelGame,
  claimAbandonment,
  finalizeAbandonment,
  importDiscoveredResolution,
  importResolution,
  planSettlement,
  readGameState,
  settleGame,
  type ActionContext,
  type ImportResult,
  type OpenClaim,
  type PrivateGame,
} from '../aztec/gameActions';
import { blockTimestamp } from '../aztec/gameChain';
import { chainNowSeconds, type ChainClock } from '../aztec/settlementArgs';
import { assessStuckGame, type StuckGame, type StuckGameFacts } from '../aztec/stuckGame';
import { orderTranscript, winnerOf } from '../aztec/privateGame';
import { TOTAL_MOVES } from '../aztec/gameConstants';
import { commitIsStale, toPrivateGame, type PersistedGameState, type UseGameStorageReturn } from './useGameStorage';
import type { PeerPayload } from '../aztec/peerChannel';

/** The chain facts `assessStuckGame` decides on. */
export async function gatherStuckGameFacts(
  saved: PersistedGameState,
  game: PrivateGame,
  ctx: ActionContext,
): Promise<StuckGameFacts> {
  const { state, position } = await readGameState(game, ctx);
  const moveProofs = saved.collectedMoveProofs ?? [];
  let transcriptComplete = false;
  let weSettle = false;
  if (moveProofs.length >= TOTAL_MOVES) {
    try {
      const winner = winnerOf(orderTranscript(moveProofs));
      transcriptComplete = true;
      weSettle = winner === 'draw' ? game.role === 1 : winner === game.role;
    } catch {
      // Not a complete, chained transcript: treat the game as unfinished.
    }
  }
  const timed = !state.done && !transcriptComplete && (position.kind === 'open-claim' || position.kind === 'can-claim');
  return {
    role: game.role,
    record2Known: !!game.record2,
    state,
    position,
    transcriptComplete,
    weSettle,
    finishedAt: saved.finishedAt,
    nowMs: Date.now(),
    chainNow: timed ? await chainNowSeconds(ctx.node as ChainClock) : 0,
    clockAt: timed && position.kind === 'can-claim' ? await blockTimestamp(ctx.node, position.clockBlock) : undefined,
    claimAt: timed && position.kind === 'open-claim' ? await blockTimestamp(ctx.node, position.claimBlock) : undefined,
  };
}

/**
 * Walk the stored games that may still hold this player's cards, oldest
 * first. A game that already resolved has its notes imported and its record
 * dropped; a commit that never landed is dropped once nothing sent for it can
 * still land. Returns the first game the player can act on (or must wait
 * for), or null.
 */
export async function inspectStuckGame(
  storage: Pick<UseGameStorageReturn, 'listClaimable' | 'clearGame'>,
  ctx: ActionContext,
  hooks: {
    onImported?: (result: ImportResult) => void;
    /** A game the live session is still working on (a settlement running in the background). */
    skip?: (roomId: string) => boolean;
  } = {},
): Promise<StuckGame | null> {
  for (const saved of storage.listClaimable()) {
    if (hooks.skip?.(saved.gameId)) continue;
    const game = toPrivateGame(saved);
    if (!game) continue;
    const assessment = assessStuckGame(await gatherStuckGameFacts(saved, game, ctx));
    switch (assessment.kind) {
      case 'resolved': {
        const result = await importDiscoveredResolution(game, ctx, {
          moveProofs: saved.collectedMoveProofs,
          fallback: announcedResolution(saved.collectedMoveProofs, saved.prizeMove),
          label: 'Resolved game',
        });
        if (result) {
          hooks.onImported?.(result);
          storage.clearGame(saved.gameId);
        }
        continue;
      }
      case 'not-committed':
        if (commitIsStale(saved)) storage.clearGame(saved.gameId);
        continue;
      case 'wait':
        continue;
      default:
        return { roomId: saved.gameId, ...assessment };
    }
  }
  return null;
}

async function finalizeOrImport(game: PrivateGame, ctx: ActionContext, claim: OpenClaim, saved: PersistedGameState) {
  const result = await finalizeAbandonment(game, ctx, claim);
  if (result) return result;
  // Resolved another way while the window ran — a settlement beats a claim.
  return importDiscoveredResolution(game, ctx, {
    moveProofs: saved.collectedMoveProofs,
    fallback: announcedResolution(saved.collectedMoveProofs, saved.prizeMove),
  });
}

/**
 * Do what the stuck game allows: cancel it, settle it, claim and finalize it,
 * or finalize a standing claim. Returns the import, or null when nothing was
 * imported (the next check will say what changed).
 */
export async function recoverStuckGame(
  stuck: StuckGame,
  saved: PersistedGameState,
  game: PrivateGame,
  ctx: ActionContext,
  deps: {
    storage: Pick<UseGameStorageReturn, 'mergeGame'>;
    /** Best effort: tell the other player (sealed), if their key is stored. */
    sendPeerFor?: (roomId: string, payload: PeerPayload) => Promise<boolean>;
    /** An abandoned game was unwound: the relay may release the room. */
    onUnwound?: (roomId: string) => void;
  },
): Promise<ImportResult | null> {
  const tell = (payload: PeerPayload) => {
    void deps.sendPeerFor?.(game.roomId, payload).catch(() => false);
  };
  const moveProofs = saved.collectedMoveProofs ?? [];
  switch (stuck.kind) {
    case 'cancellable': {
      const result = await cancelGame(game, ctx);
      tell({ kind: 'CANCELLED' });
      return result;
    }
    case 'settleable': {
      const plan = planSettlement(moveProofs, null);
      const announced = plan.winner === 'draw' ? null : plan.prizeMove;
      deps.storage.mergeGame(game.roomId, { prizeMove: announced });
      tell({ kind: 'SETTLING', prizeMove: announced });
      const txHash = await settleGame(game, ctx, { moveProofs, prizeMove: plan.prizeMove });
      deps.storage.mergeGame(game.roomId, { resolutionTxHash: txHash });
      tell({ kind: 'SETTLED', txHash });
      return importResolution(game, ctx, {
        txHash,
        resolution: { kind: 'settled', winner: plan.winner, prize: plan.prize ?? undefined },
        moveProofs,
        label: 'Settlement',
      });
    }
    case 'claimable': {
      const claim = await claimAbandonment(game, ctx);
      // Theirs, filed first: the next check offers the contest instead.
      if (claim.claimSide !== game.role) return null;
      const result = await finalizeOrImport(game, ctx, claim, saved);
      if (result?.resolution.kind === 'unwound') deps.onUnwound?.(game.roomId);
      return result;
    }
    case 'finalizable': {
      if (!stuck.claim) return null;
      const result = await finalizeOrImport(game, ctx, stuck.claim, saved);
      if (result?.resolution.kind === 'unwound') deps.onUnwound?.(game.roomId);
      return result;
    }
    default:
      return null;
  }
}
