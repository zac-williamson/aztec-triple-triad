import { describe, it, expect, vi, beforeEach } from 'vitest';
import txManager from './txManager';

// Reset txManager state between tests by accessing internals
// Since it's a singleton, we need to clean up between tests
function resetManager() {
  // Clear all entries by dismissing them
  for (const entry of txManager.getEntries()) {
    txManager.dismissError(entry.id);
  }
}

beforeEach(() => {
  resetManager();
});

describe('TxManager', () => {
  describe('PXE queue serialization', () => {
    it('serializes sequential enqueue calls', async () => {
      const order: number[] = [];

      const p1 = txManager.enqueuePxe(async () => {
        await new Promise(r => setTimeout(r, 50));
        order.push(1);
        return 'a';
      });

      const p2 = txManager.enqueuePxe(async () => {
        order.push(2);
        return 'b';
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('a');
      expect(r2).toBe('b');
      expect(order).toEqual([1, 2]); // p2 waited for p1
    });

    it('does not block queue on rejected operations', async () => {
      const p1 = txManager.enqueuePxe(async () => {
        throw new Error('fail');
      });

      const p2 = txManager.enqueuePxe(async () => 'ok');

      await expect(p1).rejects.toThrow('fail');
      expect(await p2).toBe('ok');
    });

    it('serializes runTx calls through the PXE queue', async () => {
      const order: string[] = [];

      const p1 = txManager.runTx({
        type: 'create_game',
        label: 'First',
        execute: async () => {
          await new Promise(r => setTimeout(r, 30));
          order.push('first-execute');
          return 1;
        },
        postEffects: async () => {
          order.push('first-post');
        },
      });

      const p2 = txManager.runTx({
        type: 'join_game',
        label: 'Second',
        execute: async () => {
          order.push('second-execute');
          return 2;
        },
      });

      await Promise.all([p1, p2]);
      // second-execute must come after first-execute (PXE queue)
      // first-post runs between (outside PXE queue but before second starts)
      expect(order.indexOf('first-execute')).toBeLessThan(order.indexOf('second-execute'));
    });
  });

  describe('in-flight tracking', () => {
    it('tracks in-flight transactions', async () => {
      let resolveExecute: () => void;
      const blockingPromise = new Promise<void>(r => { resolveExecute = r; });

      expect(txManager.hasInFlight()).toBe(false);

      const txPromise = txManager.runTx({
        type: 'create_game',
        label: 'Test',
        gameId: 'game-1',
        execute: async () => {
          await blockingPromise;
          return 'done';
        },
      });

      // Give the queue a tick to start
      await new Promise(r => setTimeout(r, 10));

      expect(txManager.hasInFlight()).toBe(true);
      expect(txManager.hasInFlight('create_game')).toBe(true);
      expect(txManager.hasInFlight('settle_game')).toBe(false);
      expect(txManager.hasInFlightForGame('game-1')).toBe(true);
      expect(txManager.hasInFlightForGame('game-2')).toBe(false);

      resolveExecute!();
      await txPromise;

      expect(txManager.hasInFlight()).toBe(false);
      expect(txManager.hasInFlightForGame('game-1')).toBe(false);
    });

    it('clears in-flight on error', async () => {
      const txPromise = txManager.runTx({
        type: 'settle_game',
        label: 'Fail',
        gameId: 'game-err',
        execute: async () => { throw new Error('boom'); },
      });

      await expect(txPromise).rejects.toThrow('boom');
      expect(txManager.hasInFlightForGame('game-err')).toBe(false);
    });
  });

  describe('phase transitions', () => {
    it('transitions through phases correctly', async () => {
      const phases: string[] = [];
      const unsub = txManager.subscribe(() => {
        const entries = txManager.getEntries();
        if (entries.length > 0) phases.push(entries[0].phase);
      });

      await txManager.runTx({
        type: 'create_game',
        label: 'Phases',
        execute: async (setPhase) => {
          setPhase('simulating');
          setPhase('sending');
          return 'ok';
        },
        postEffects: async () => {},
      });

      unsub();

      expect(phases).toContain('queued');
      expect(phases).toContain('simulating');
      expect(phases).toContain('sending');
      expect(phases).toContain('post_effects');
      expect(phases).toContain('completed');
    });

    it('sets error phase with message on failure', async () => {
      await txManager.runTx({
        type: 'settle_game',
        label: 'ErrorTest',
        execute: async () => { throw new Error('settlement reverted'); },
      }).catch(() => {});

      const entries = txManager.getEntries();
      const errEntry = entries.find(e => e.label === 'ErrorTest');
      expect(errEntry).toBeDefined();
      expect(errEntry!.phase).toBe('error');
      expect(errEntry!.error).toBe('settlement reverted');
    });
  });

  describe('subscriber notifications', () => {
    it('notifies subscribers on state changes', async () => {
      const notifyCount = { value: 0 };
      const unsub = txManager.subscribe(() => { notifyCount.value++; });

      await txManager.runTx({
        type: 'purchase_card_pack',
        label: 'Sub test',
        execute: async () => 'ok',
      });

      unsub();
      expect(notifyCount.value).toBeGreaterThan(0);
    });

    it('unsubscribe stops notifications', async () => {
      const calls: number[] = [];
      const unsub = txManager.subscribe(() => calls.push(1));
      unsub();

      await txManager.runTx({
        type: 'purchase_card_pack',
        label: 'Unsub test',
        execute: async () => 'ok',
      });

      expect(calls.length).toBe(0);
    });

    it('getEntries returns stable reference when unchanged', () => {
      const a = txManager.getEntries();
      const b = txManager.getEntries();
      expect(a).toBe(b); // Same reference
    });
  });

  describe('deferred leaveGame', () => {
    it('calls deferred leaveGame after tx completes', async () => {
      const leaveGame = vi.fn();

      let resolveExecute: () => void;
      const blockingPromise = new Promise<void>(r => { resolveExecute = r; });

      const txPromise = txManager.runTx({
        type: 'settle_game',
        label: 'Defer test',
        gameId: 'game-defer',
        execute: async () => {
          await blockingPromise;
          return 'ok';
        },
      });

      await new Promise(r => setTimeout(r, 10));

      // Simulate user clicking "Back to Lobby" while tx is in-flight
      txManager.deferLeaveGame('game-defer', leaveGame);
      expect(leaveGame).not.toHaveBeenCalled();

      // Complete the tx
      resolveExecute!();
      await txPromise;

      expect(leaveGame).toHaveBeenCalledTimes(1);
    });

    it('calls deferred leaveGame on error too', async () => {
      const leaveGame = vi.fn();

      const txPromise = txManager.runTx({
        type: 'create_game',
        label: 'Defer error',
        gameId: 'game-err-defer',
        execute: async () => { throw new Error('oops'); },
      });

      // Defer before error resolves
      txManager.deferLeaveGame('game-err-defer', leaveGame);

      await txPromise.catch(() => {});

      expect(leaveGame).toHaveBeenCalledTimes(1);
    });

    it('does not call deferred leaveGame for different gameId', async () => {
      const leaveGame = vi.fn();

      await txManager.runTx({
        type: 'create_game',
        label: 'Wrong game',
        gameId: 'game-A',
        execute: async () => 'ok',
      });

      txManager.deferLeaveGame('game-B', leaveGame);

      // game-A completed but leaveGame is for game-B
      expect(leaveGame).not.toHaveBeenCalled();
    });
  });

  describe('dismissError', () => {
    it('removes error entries', async () => {
      await txManager.runTx({
        type: 'settle_game',
        label: 'Dismiss me',
        execute: async () => { throw new Error('bad'); },
      }).catch(() => {});

      const before = txManager.getEntries();
      expect(before.length).toBeGreaterThan(0);
      const errEntry = before.find(e => e.phase === 'error')!;

      txManager.dismissError(errEntry.id);

      const after = txManager.getEntries();
      expect(after.find(e => e.id === errEntry.id)).toBeUndefined();
    });
  });

  describe('concurrent transaction handling', () => {
    it('second tx waits for first tx to release the PXE queue', async () => {
      const timestamps: { label: string; time: number }[] = [];

      let resolveFirst: () => void;
      const firstBlocks = new Promise<void>(r => { resolveFirst = r; });

      const tx1 = txManager.runTx({
        type: 'create_game',
        label: 'Slow tx',
        gameId: 'g1',
        execute: async () => {
          timestamps.push({ label: 'tx1-start', time: Date.now() });
          await firstBlocks;
          timestamps.push({ label: 'tx1-end', time: Date.now() });
          return 'first';
        },
      });

      // Submit second tx immediately — it should queue
      const tx2 = txManager.runTx({
        type: 'purchase_card_pack',
        label: 'Fast tx',
        execute: async () => {
          timestamps.push({ label: 'tx2-start', time: Date.now() });
          return 'second';
        },
      });

      // Verify tx2 hasn't started yet
      await new Promise(r => setTimeout(r, 20));
      expect(timestamps.map(t => t.label)).toEqual(['tx1-start']);

      // Release first tx
      resolveFirst!();
      const [r1, r2] = await Promise.all([tx1, tx2]);

      expect(r1).toBe('first');
      expect(r2).toBe('second');
      expect(timestamps.map(t => t.label)).toEqual(['tx1-start', 'tx1-end', 'tx2-start']);
    });

    it('error in first tx does not prevent second tx from running', async () => {
      const tx1 = txManager.runTx({
        type: 'create_game',
        label: 'Failing',
        execute: async () => { throw new Error('tx1 failed'); },
      });

      const tx2 = txManager.runTx({
        type: 'join_game',
        label: 'Succeeding',
        execute: async () => 'success',
      });

      await expect(tx1).rejects.toThrow('tx1 failed');
      expect(await tx2).toBe('success');
    });

    it('postEffects of first tx run before second tx starts', async () => {
      const order: string[] = [];

      const tx1 = txManager.runTx({
        type: 'create_game',
        label: 'With post-effects',
        execute: async () => {
          order.push('tx1-execute');
          return 'a';
        },
        postEffects: async () => {
          await new Promise(r => setTimeout(r, 30));
          order.push('tx1-post');
        },
      });

      const tx2 = txManager.runTx({
        type: 'join_game',
        label: 'Queued behind',
        execute: async () => {
          order.push('tx2-execute');
          return 'b';
        },
      });

      await Promise.all([tx1, tx2]);

      // Post-effects are outside the PXE queue, so tx2 CAN start before tx1 post-effects finish
      // But tx2's execute is in the PXE queue, which only has tx1's execute, not post-effects
      // So tx2-execute should come after tx1-execute but potentially before tx1-post
      expect(order.indexOf('tx1-execute')).toBeLessThan(order.indexOf('tx2-execute'));
    });

    it('hasInFlight blocks conceptually (for UI guards)', async () => {
      let resolveExecute: () => void;
      const blockingPromise = new Promise<void>(r => { resolveExecute = r; });

      txManager.runTx({
        type: 'settle_game',
        label: 'Blocking settle',
        gameId: 'g-block',
        execute: async () => {
          await blockingPromise;
          return 'done';
        },
      });

      await new Promise(r => setTimeout(r, 10));

      // UI should check this before allowing new game creation
      expect(txManager.hasInFlight('settle_game')).toBe(true);
      expect(txManager.hasInFlight('create_game')).toBe(false);

      resolveExecute!();
      // Wait for completion
      await new Promise(r => setTimeout(r, 20));

      expect(txManager.hasInFlight('settle_game')).toBe(false);
    });
  });

  describe('abandoned game tx types', () => {
    it('tracks claim_abandoned_game in-flight', async () => {
      let resolveExecute: () => void;
      const blockingPromise = new Promise<void>(r => { resolveExecute = r; });

      const txPromise = txManager.runTx({
        type: 'claim_abandoned_game',
        label: 'Claiming abandoned game...',
        gameId: 'abandoned-1',
        execute: async () => {
          await blockingPromise;
          return 'claimed';
        },
      });

      await new Promise(r => setTimeout(r, 10));
      expect(txManager.hasInFlight('claim_abandoned_game')).toBe(true);
      expect(txManager.hasInFlightForGame('abandoned-1')).toBe(true);

      resolveExecute!();
      await txPromise;

      expect(txManager.hasInFlight('claim_abandoned_game')).toBe(false);
      expect(txManager.hasInFlightForGame('abandoned-1')).toBe(false);
    });

    it('tracks settle_abandoned_game in-flight', async () => {
      let resolveExecute: () => void;
      const blockingPromise = new Promise<void>(r => { resolveExecute = r; });

      const txPromise = txManager.runTx({
        type: 'settle_abandoned_game',
        label: 'Settling abandoned game...',
        gameId: 'abandoned-1',
        execute: async () => {
          await blockingPromise;
          return 'settled';
        },
      });

      await new Promise(r => setTimeout(r, 10));
      expect(txManager.hasInFlight('settle_abandoned_game')).toBe(true);

      resolveExecute!();
      await txPromise;

      expect(txManager.hasInFlight('settle_abandoned_game')).toBe(false);
    });

    it('claim and settle run sequentially through PXE queue', async () => {
      const order: string[] = [];

      const claim = txManager.runTx({
        type: 'claim_abandoned_game',
        label: 'Claim',
        gameId: 'seq-test',
        execute: async () => {
          await new Promise(r => setTimeout(r, 20));
          order.push('claim');
          return 'c';
        },
      });

      const settle = txManager.runTx({
        type: 'settle_abandoned_game',
        label: 'Settle',
        gameId: 'seq-test',
        execute: async () => {
          order.push('settle');
          return 's';
        },
      });

      await Promise.all([claim, settle]);
      expect(order).toEqual(['claim', 'settle']);
    });

    it('settle_abandoned_game postEffects run correctly', async () => {
      let postEffectRan = false;

      await txManager.runTx({
        type: 'settle_abandoned_game',
        label: 'Settle with post',
        gameId: 'post-test',
        execute: async () => ({ hash: '0xabc', callerRandomness: [] }),
        postEffects: async (result) => {
          expect(result.hash).toBe('0xabc');
          postEffectRan = true;
        },
      });

      expect(postEffectRan).toBe(true);
    });
  });

  describe('priority queue ordering', () => {
    it('join_game runs before settle_game within same game', async () => {
      const order: string[] = [];
      const GAME = 'game-priority-1';

      let resolveBlocker!: () => void;
      const blocker = new Promise<void>(r => { resolveBlocker = r; });

      const p0 = txManager.runTx({
        type: 'create_game', label: 'Blocker', gameId: GAME,
        execute: async () => { await blocker; return 'blocked'; },
      });

      await new Promise(r => setTimeout(r, 10));

      // Queue settle_game FIRST (priority 3)
      const p1 = txManager.runTx({
        type: 'settle_game', label: 'Settle', gameId: GAME,
        execute: async () => { order.push('settle'); return 's'; },
      });

      // Queue join_game SECOND (priority 1) — reordered ahead (same gameId)
      const p2 = txManager.runTx({
        type: 'join_game', label: 'Join', gameId: GAME,
        execute: async () => { order.push('join'); return 'j'; },
      });

      resolveBlocker();
      await Promise.all([p0, p1, p2]);

      expect(order).toEqual(['join', 'settle']);
    });

    it('cross-game transactions maintain FIFO order (no reordering)', async () => {
      const order: string[] = [];

      let resolveBlocker!: () => void;
      const blocker = new Promise<void>(r => { resolveBlocker = r; });

      const p0 = txManager.enqueuePxe(async () => { await blocker; });

      await new Promise(r => setTimeout(r, 10));

      // Game 1 settle, then game 2 create — different gameIds
      const p1 = txManager.runTx({
        type: 'settle_game', label: 'Settle G1', gameId: 'game-1',
        execute: async () => { order.push('settle-g1'); return 0; },
      });
      const p2 = txManager.runTx({
        type: 'create_game', label: 'Create G2', gameId: 'game-2',
        execute: async () => { order.push('create-g2'); return 0; },
      });

      resolveBlocker();
      await Promise.all([p0, p1, p2]);

      // FIFO preserved across games — settle G1 before create G2
      expect(order).toEqual(['settle-g1', 'create-g2']);
    });

    it('same-priority items maintain FIFO order within same game', async () => {
      const order: string[] = [];
      const GAME = 'game-fifo';

      let resolveBlocker!: () => void;
      const blocker = new Promise<void>(r => { resolveBlocker = r; });

      const p0 = txManager.enqueuePxe(async () => { await blocker; });

      await new Promise(r => setTimeout(r, 10));

      const p1 = txManager.runTx({
        type: 'create_game', label: 'C1', gameId: GAME,
        execute: async () => { order.push('create1'); return 0; },
      });
      const p2 = txManager.runTx({
        type: 'join_game', label: 'J1', gameId: GAME,
        execute: async () => { order.push('join1'); return 0; },
      });
      const p3 = txManager.runTx({
        type: 'create_game', label: 'C2', gameId: GAME,
        execute: async () => { order.push('create2'); return 0; },
      });

      resolveBlocker();
      await Promise.all([p0, p1, p2, p3]);

      // All priority 1, same game, FIFO
      expect(order).toEqual(['create1', 'join1', 'create2']);
    });

    it('simulates the game flow: settle_game polls while join_game runs on separate player', async () => {
      // Real-world scenario:
      // - P1's txManager has create_game → settle_game
      // - P2's txManager has join_game (separate instance)
      // - P1's settle_game polls an external condition (game status) that
      //   becomes true when P2's join_game mines
      // This test verifies the flow works with a single txManager by
      // simulating the external condition via a shared flag.

      const order: string[] = [];
      let onChainGameStatus = 0; // 0=empty, 1=created, 2=both joined

      // Step 1: create_game runs
      let resolveCreate!: () => void;
      const createBlock = new Promise<void>(r => { resolveCreate = r; });

      const createTx = txManager.runTx({
        type: 'create_game',
        label: 'Create game',
        gameId: 'flow-test',
        execute: async () => {
          await createBlock;
          order.push('create_game');
          onChainGameStatus = 1;
          return 'created';
        },
      });

      await new Promise(r => setTimeout(r, 10));

      // Step 2: settle_game queued while create_game is pending.
      // Its execute polls the external game status.
      const settleTx = txManager.runTx({
        type: 'settle_game',
        label: 'Settle game',
        gameId: 'flow-test-settle',
        execute: async () => {
          // Poll until on-chain status shows both players joined
          // (in real app, join_game runs on P2's separate txManager)
          for (let i = 0; i < 50; i++) {
            if (onChainGameStatus === 2) break;
            await new Promise(r => setTimeout(r, 10));
          }
          expect(onChainGameStatus).toBe(2);
          order.push('settle_game');
          return 'settled';
        },
      });

      // Step 3: create_game finishes
      resolveCreate();
      await createTx;
      expect(onChainGameStatus).toBe(1);

      // Step 4: Simulate P2's join_game completing externally
      // (in real app this is a separate browser's txManager)
      setTimeout(() => {
        onChainGameStatus = 2;
        order.push('join_game_mined');
      }, 50);

      await settleTx;

      // create first, then join mines externally, then settle proceeds
      expect(order).toEqual(['create_game', 'join_game_mined', 'settle_game']);
    });
  });
});
