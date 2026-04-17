/**
 * Tests for handleSettle called at every possible on-chain phase.
 *
 * The user can click "settle" at any time during the on-chain pipeline:
 *   P1: idle → creating → awaiting_join → active
 *   P2: idle → preparing → awaiting_create → joining → active
 *
 * In all cases the settlement must wait for 'active' before proceeding.
 * These tests simulate each phase by controlling txManager queue timing
 * and phase transitions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use real txManager — this is the core of what we're testing
import txManager from '../../aztec/txManager';
import type { TxPhase } from '../../aztec/txManager';

/**
 * Simulates the settlement execute callback's active-wait logic.
 * Extracted from useGame.ts handleSettle to test in isolation with
 * controlled phase transitions.
 */
function createSettlementWaiter(opts: {
  getPhase: () => string;
  activeResolveRef: { current: (() => void) | null };
  timeoutMs: number;
}) {
  const { getPhase, activeResolveRef, timeoutMs } = opts;

  return async function waitForActive(): Promise<void> {
    if (getPhase() === 'active') return;

    await new Promise<void>((resolve, reject) => {
      if (getPhase() === 'active') { resolve(); return; }
      activeResolveRef.current = resolve;
      setTimeout(() => {
        activeResolveRef.current = null;
        reject(new Error(`Timed out waiting for active (phase: ${getPhase()})`));
      }, timeoutMs);
    });
  };
}

/**
 * Simulates transitionPhase — fires the activeResolveRef when
 * transitioning to 'active'.
 */
function createPhaseManager() {
  let currentPhase = 'idle';
  const activeResolveRef: { current: (() => void) | null } = { current: null };

  return {
    get phase() { return currentPhase; },
    set phase(p: string) {
      currentPhase = p;
      if (p === 'active' && activeResolveRef.current) {
        activeResolveRef.current();
        activeResolveRef.current = null;
      }
    },
    activeResolveRef,
    getPhase: () => currentPhase,
  };
}

describe('handleSettle active-wait at each P1 phase', () => {
  it('settle during idle: waits for active, succeeds when pipeline completes', async () => {
    const pm = createPhaseManager();
    pm.phase = 'idle';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    // Start waiting (will block until active)
    const waitPromise = waiter();

    // Simulate pipeline: idle → creating → awaiting_join → active
    pm.phase = 'creating';
    pm.phase = 'awaiting_join';

    // Still waiting (not active yet)
    await new Promise(r => setTimeout(r, 50));
    expect(pm.activeResolveRef.current).not.toBeNull();

    // P2 joins → active
    pm.phase = 'active';

    // Wait should resolve
    await waitPromise; // no error = success
  });

  it('settle during creating: waits for active, succeeds when create + join complete', async () => {
    const pm = createPhaseManager();
    pm.phase = 'creating';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    const waitPromise = waiter();

    // create_game mined
    pm.phase = 'awaiting_join';

    // Still waiting
    await new Promise(r => setTimeout(r, 20));
    expect(pm.activeResolveRef.current).not.toBeNull();

    // P2 joins
    pm.phase = 'active';
    await waitPromise;
  });

  it('settle during awaiting_join: waits for active, succeeds when P2 joins', async () => {
    const pm = createPhaseManager();
    pm.phase = 'awaiting_join';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    const waitPromise = waiter();

    // Waiting for P2
    await new Promise(r => setTimeout(r, 20));
    expect(pm.activeResolveRef.current).not.toBeNull();

    // P2 joins
    pm.phase = 'active';
    await waitPromise;
  });

  it('settle during active: skips wait, proceeds immediately', async () => {
    const pm = createPhaseManager();
    pm.phase = 'active';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    // Should resolve immediately (no waiting)
    await waiter();
    // activeResolveRef should NOT have been set (fast path)
    expect(pm.activeResolveRef.current).toBeNull();
  });

  it('settle times out if active never reached', async () => {
    const pm = createPhaseManager();
    pm.phase = 'awaiting_join';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 100, // short timeout for test
    });

    await expect(waiter()).rejects.toThrow('Timed out waiting for active');
  });
});

describe('handleSettle active-wait at each P2 phase', () => {
  it('settle during preparing: waits through preparing → awaiting_create → joining → active', async () => {
    const pm = createPhaseManager();
    pm.phase = 'preparing';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    const waitPromise = waiter();

    // Pipeline progresses
    pm.phase = 'awaiting_create';
    pm.phase = 'joining';

    await new Promise(r => setTimeout(r, 20));
    expect(pm.activeResolveRef.current).not.toBeNull();

    pm.phase = 'active';
    await waitPromise;
  });

  it('settle during awaiting_create: waits for P1 confirm + own join', async () => {
    const pm = createPhaseManager();
    pm.phase = 'awaiting_create';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    const waitPromise = waiter();

    pm.phase = 'joining';
    await new Promise(r => setTimeout(r, 20));

    pm.phase = 'active';
    await waitPromise;
  });

  it('settle during joining: waits for join_game to mine', async () => {
    const pm = createPhaseManager();
    pm.phase = 'joining';

    const waiter = createSettlementWaiter({
      getPhase: pm.getPhase,
      activeResolveRef: pm.activeResolveRef,
      timeoutMs: 2000,
    });

    const waitPromise = waiter();
    await new Promise(r => setTimeout(r, 20));
    expect(pm.activeResolveRef.current).not.toBeNull();

    pm.phase = 'active';
    await waitPromise;
  });
});

describe('txManager queue + phase interaction (end-to-end)', () => {
  it('settle queued during create_game: create postEffects run first, settle waits for active', async () => {
    const pm = createPhaseManager();
    pm.phase = 'idle';

    const order: string[] = [];

    // Simulate create_game pipeline
    const pCreate = txManager.runTx({
      type: 'create_game',
      label: 'create-e2e',
      gameId: 'e2e-1',
      execute: async () => {
        order.push('create-execute');
        pm.phase = 'creating';
        // Simulate tx mining delay
        await new Promise(r => setTimeout(r, 30));
        return { gameId: '0xGAME', randomness: [], txHash: '0xTX' };
      },
      postEffects: async () => {
        order.push('create-postEffects');
        pm.phase = 'awaiting_join';
      },
    });

    // User clicks settle while create_game is in flight
    const pSettle = txManager.runTx({
      type: 'settle_game',
      label: 'settle-e2e',
      gameId: 'e2e-1',
      execute: async () => {
        order.push('settle-execute-start');

        // This is the real active-wait logic from handleSettle
        if (pm.getPhase() !== 'active') {
          await new Promise<void>((resolve, reject) => {
            if (pm.getPhase() === 'active') { resolve(); return; }
            pm.activeResolveRef.current = resolve;
            setTimeout(() => {
              pm.activeResolveRef.current = null;
              reject(new Error(`Timeout (phase: ${pm.getPhase()})`));
            }, 2000);
          });
        }

        order.push('settle-execute-active');
        return {};
      },
    });

    // Simulate P2 joining after a delay (after create postEffects)
    setTimeout(() => {
      order.push('p2-joins');
      pm.phase = 'active';
    }, 150);

    await Promise.all([pCreate, pSettle]);

    // Verify ordering:
    // 1. create-execute runs first (higher priority)
    // 2. create-postEffects completes (atomic with execute in queue)
    // 3. settle-execute-start begins
    // 4. settle waits for active
    // 5. P2 joins → active
    // 6. settle proceeds
    expect(order.indexOf('create-execute')).toBeLessThan(order.indexOf('create-postEffects'));
    expect(order.indexOf('create-postEffects')).toBeLessThan(order.indexOf('settle-execute-start'));
    expect(order.indexOf('settle-execute-start')).toBeLessThan(order.indexOf('p2-joins'));
    expect(order.indexOf('p2-joins')).toBeLessThan(order.indexOf('settle-execute-active'));
  });

  it('settle queued during active: no waiting, proceeds immediately', async () => {
    const pm = createPhaseManager();
    pm.phase = 'active'; // Game already active

    const order: string[] = [];

    const pSettle = txManager.runTx({
      type: 'settle_game',
      label: 'settle-fast',
      gameId: 'fast-1',
      execute: async () => {
        order.push('settle-start');

        // Active-wait — should skip immediately
        if (pm.getPhase() !== 'active') {
          throw new Error('Should not wait');
        }

        order.push('settle-proceed');
        return {};
      },
    });

    await pSettle;

    expect(order).toEqual(['settle-start', 'settle-proceed']);
  });

  it('two games sequential: game 1 settle completes before game 2 create starts', async () => {
    const order: string[] = [];

    // Game 1: create + settle
    await txManager.runTx({
      type: 'create_game',
      label: 'g1-create',
      gameId: 'game-1',
      execute: async () => { order.push('g1-create'); return {}; },
    });

    await txManager.runTx({
      type: 'settle_game',
      label: 'g1-settle',
      gameId: 'game-1',
      execute: async () => { order.push('g1-settle'); return {}; },
    });

    // Game 2: create
    await txManager.runTx({
      type: 'create_game',
      label: 'g2-create',
      gameId: 'game-2',
      execute: async () => { order.push('g2-create'); return {}; },
    });

    expect(order).toEqual(['g1-create', 'g1-settle', 'g2-create']);
  });
});
