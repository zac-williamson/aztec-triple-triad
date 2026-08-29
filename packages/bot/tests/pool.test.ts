import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BotPool } from '../src/pool.js';

class FakeProc extends EventEmitter {
  killed: string | null = null;
  kill(sig: string) { this.killed = sig; return true; }
}

function spawner() {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; proc: FakeProc }[] = [];
  const fn = ((_cmd: string, args: string[], opts: any) => {
    const proc = new FakeProc();
    spawned.push({ args, env: opts.env, proc });
    return proc as any;
  }) as any;
  return { spawned, fn };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BotPool', () => {
  it('starts one process per identity index', () => {
    const s = spawner();
    new BotPool({ size: 3, spawnFn: s.fn, log: () => {} }).start();
    expect(s.spawned).toHaveLength(3);
    expect(s.spawned.map(p => p.env.ARENA_BOT_INDEX)).toEqual(['0', '1', '2']);
  });

  it('gives every bot its own health port', () => {
    const s = spawner();
    new BotPool({ size: 3, healthPortBase: 5175, spawnFn: s.fn, log: () => {} }).start();
    // Sharing one port means every bot after the first logs EADDRINUSE and
    // serves no health data at all — the pool would be unmonitorable.
    expect(s.spawned.map(p => p.env.ARENA_BOT_HEALTH_PORT)).toEqual(['5175', '5176', '5177']);
  });

  it('honours a start index, so two pools can share a machine', () => {
    const s = spawner();
    new BotPool({ size: 2, startIndex: 4, spawnFn: s.fn, log: () => {} }).start();
    expect(s.spawned.map(p => p.env.ARENA_BOT_INDEX)).toEqual(['4', '5']);
  });

  it('restarts a child that dies', () => {
    const s = spawner();
    const pool = new BotPool({ size: 1, spawnFn: s.fn, log: () => {}, restartDelayMs: 1000 });
    pool.start();
    // A crashed bot is holding five committed cards, and only a live process
    // runs the sweep that gets them back.
    s.spawned[0].proc.emit('exit', 1, null);
    vi.advanceTimersByTime(1000);
    expect(s.spawned).toHaveLength(2);
    expect(s.spawned[1].env.ARENA_BOT_INDEX).toBe('0');
  });

  it('gives up on a child that dies instantly, over and over', () => {
    const s = spawner();
    const pool = new BotPool({
      size: 1, spawnFn: s.fn, log: () => {}, restartDelayMs: 10, maxRestarts: 3, minUptimeMs: 30_000,
    });
    pool.start();
    for (let i = 0; i < 10; i++) {
      const last = s.spawned[s.spawned.length - 1];
      last.proc.emit('exit', 1, null);
      vi.advanceTimersByTime(10);
    }
    // Respawning forever buries the real error under a scroll of restarts.
    expect(s.spawned.length).toBe(4);   // initial + maxRestarts(3), then it stops
  });

  it('resets the restart counter for a child that ran for a while', () => {
    const s = spawner();
    const pool = new BotPool({
      size: 1, spawnFn: s.fn, log: () => {}, restartDelayMs: 10, maxRestarts: 2, minUptimeMs: 1_000,
    });
    pool.start();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5_000);                 // healthy uptime
      s.spawned[s.spawned.length - 1].proc.emit('exit', 0, null);
      vi.advanceTimersByTime(10);
    }
    // A bot that runs for hours and then crashes is not a broken config.
    expect(s.spawned.length).toBe(7);
  });

  it('does not restart after stop()', () => {
    const s = spawner();
    const pool = new BotPool({ size: 1, spawnFn: s.fn, log: () => {}, restartDelayMs: 10 });
    pool.start();
    pool.stop();
    s.spawned[0].proc.emit('exit', 0, 'SIGTERM');
    vi.advanceTimersByTime(1000);
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0].proc.killed).toBe('SIGTERM');
  });

  it('refuses to start when an identity is missing, naming which', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pool-'));
    try {
      writeFileSync(join(dir, 'arena-bot-0.json'), '{}');
      const pool = new BotPool({ size: 3, spawnFn: spawner().fn, log: () => {} });
      // Starting 1 of 3 and logging two stack traces is far worse than refusing.
      expect(() => pool.verifyIdentities(dir)).toThrow(/index 1/);
      expect(() => pool.verifyIdentities(dir)).toThrow(/index 2/);
      expect(() => pool.verifyIdentities(dir)).toThrow(/globally unique/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a fully provisioned pool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pool-'));
    try {
      for (const i of [0, 1]) writeFileSync(join(dir, `arena-bot-${i}.json`), '{}');
      expect(() => new BotPool({ size: 2, log: () => {} }).verifyIdentities(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
