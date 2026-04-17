/**
 * txManager tests — PXE queue serialization, priority ordering, and
 * postEffects atomicity.
 *
 * Bug #4 (postEffects outside PXE queue): settle_game's execute started
 * before create_game's postEffects completed because postEffects ran
 * outside the queue. These tests verify the fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import fresh instance for each test
async function createFreshTxManager() {
  // Re-import to get a fresh class (the default export is a singleton)
  const mod = await import('../txManager');
  // Access the class via the module — the singleton is already created,
  // but we can use it since beforeEach resets state via completing all txs
  return mod.default;
}

// We'll use the singleton but ensure tests are independent
import txManager from '../txManager';

describe('txManager', () => {
  describe('PXE queue serialization', () => {
    it('executes queued items one at a time', async () => {
      const order: string[] = [];

      const p1 = txManager.runTx({
        type: 'create_game',
        label: 'tx1',
        execute: async () => {
          order.push('tx1-start');
          await new Promise(r => setTimeout(r, 50));
          order.push('tx1-end');
          return 'result1';
        },
      });

      const p2 = txManager.runTx({
        type: 'join_game',
        label: 'tx2',
        execute: async () => {
          order.push('tx2-start');
          await new Promise(r => setTimeout(r, 10));
          order.push('tx2-end');
          return 'result2';
        },
      });

      await Promise.all([p1, p2]);

      // tx1 must fully complete before tx2 starts
      expect(order).toEqual(['tx1-start', 'tx1-end', 'tx2-start', 'tx2-end']);
    });

    it('postEffects complete before next queued item starts', async () => {
      const order: string[] = [];

      const p1 = txManager.runTx({
        type: 'create_game',
        label: 'create',
        gameId: 'game-1',
        execute: async () => {
          order.push('create-execute');
          return { gameId: '0xABC' };
        },
        postEffects: async () => {
          order.push('create-postEffects-start');
          await new Promise(r => setTimeout(r, 50));
          order.push('create-postEffects-end');
        },
      });

      const p2 = txManager.runTx({
        type: 'settle_game',
        label: 'settle',
        gameId: 'game-1',
        execute: async () => {
          order.push('settle-execute');
          return {};
        },
      });

      await Promise.all([p1, p2]);

      // create's postEffects MUST complete before settle's execute starts.
      // This was Bug #4 — previously settle-execute ran between
      // create-execute and create-postEffects-end.
      expect(order).toEqual([
        'create-execute',
        'create-postEffects-start',
        'create-postEffects-end',
        'settle-execute',
      ]);
    });

    it('postEffects error propagates and does not block the queue', async () => {
      const order: string[] = [];

      const p1 = txManager.runTx({
        type: 'create_game',
        label: 'create',
        execute: async () => 'ok',
        postEffects: async () => {
          order.push('postEffects-throws');
          throw new Error('postEffects failed');
        },
      }).catch(e => {
        order.push('create-caught');
        return e;
      });

      const p2 = txManager.runTx({
        type: 'join_game',
        label: 'join',
        execute: async () => {
          order.push('join-execute');
          return 'ok';
        },
      });

      await Promise.all([p1, p2]);

      // The queue must not be stuck — join should still execute
      expect(order).toContain('join-execute');
      expect(order).toContain('create-caught');
    });
  });

  describe('priority ordering within same gameId', () => {
    it('create_game (priority 1) runs before settle_game (priority 3) for same game', async () => {
      const order: string[] = [];

      // Block the queue so both items queue up before either runs
      let unblock: () => void;
      const blocker = txManager.runTx({
        type: 'deploy_account',
        label: 'blocker',
        execute: async () => {
          await new Promise<void>(r => { unblock = r; });
          return {};
        },
      });

      // Queue settle FIRST, then create — for the same gameId
      const pSettle = txManager.runTx({
        type: 'settle_game',
        label: 'settle',
        gameId: 'game-priority',
        execute: async () => {
          order.push('settle');
          return {};
        },
      });

      const pCreate = txManager.runTx({
        type: 'create_game',
        label: 'create',
        gameId: 'game-priority',
        execute: async () => {
          order.push('create');
          return {};
        },
      });

      // Unblock — both items should now be in queue, create should run first
      unblock!();
      await Promise.all([blocker, pSettle, pCreate]);

      expect(order).toEqual(['create', 'settle']);
    });

    it('different gameIds maintain FIFO order regardless of priority', async () => {
      const order: string[] = [];

      let unblock: () => void;
      const blocker = txManager.runTx({
        type: 'deploy_account',
        label: 'blocker',
        execute: async () => {
          await new Promise<void>(r => { unblock = r; });
          return {};
        },
      });

      // Queue settle for game-A, then create for game-B
      const pSettle = txManager.runTx({
        type: 'settle_game',
        label: 'settle-A',
        gameId: 'game-A',
        execute: async () => {
          order.push('settle-A');
          return {};
        },
      });

      const pCreate = txManager.runTx({
        type: 'create_game',
        label: 'create-B',
        gameId: 'game-B',
        execute: async () => {
          order.push('create-B');
          return {};
        },
      });

      unblock!();
      await Promise.all([blocker, pSettle, pCreate]);

      // FIFO across different games — settle-A was queued first
      expect(order).toEqual(['settle-A', 'create-B']);
    });
  });

  describe('entry tracking', () => {
    it('tracks phases through the lifecycle', async () => {
      const phases: string[] = [];
      const unsub = txManager.subscribe(() => {
        const entries = txManager.getEntries();
        // Find the entry for our specific tx
        const entry = entries.find(e => e.label === 'phase-track-test');
        if (entry) phases.push(entry.phase);
      });

      await txManager.runTx({
        type: 'create_game',
        label: 'phase-track-test',
        execute: async (setPhase) => {
          setPhase('simulating');
          return {};
        },
        postEffects: async () => {},
      });

      unsub();

      // 'queued' may not appear if execute starts immediately (empty queue)
      expect(phases).toContain('simulating');
      expect(phases).toContain('post_effects');
      expect(phases).toContain('completed');
    });

    it('hasInFlight returns false after completion', async () => {
      await txManager.runTx({
        type: 'create_game',
        label: 'test',
        execute: async () => ({}),
      });

      expect(txManager.hasInFlight('create_game')).toBe(false);
    });

    it('error sets phase to error with message', async () => {
      let entryPhase = '';
      let entryError = '';

      try {
        await txManager.runTx({
          type: 'create_game',
          label: 'error-test',
          execute: async () => { throw new Error('boom'); },
        });
      } catch {
        const entries = txManager.getEntries();
        const errEntry = entries.find(e => e.label === 'error-test');
        if (errEntry) {
          entryPhase = errEntry.phase;
          entryError = errEntry.error ?? '';
        }
      }

      expect(entryPhase).toBe('error');
      expect(entryError).toBe('boom');
    });
  });
});
