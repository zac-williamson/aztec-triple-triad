/**
 * Runs a pool of arena bots as N SUPERVISED PROCESSES.
 *
 * One process per identity, not one process with N identities. `pxe.ts` binds
 * its wallet in a module-level global, so two identities in one process silently
 * share the last-connected wallet and both act as the same account — BotChain
 * throws rather than let that happen. Separate processes also isolate proving,
 * which is the actual bottleneck, and mean one wedged PXE cannot take the pool
 * down with it.
 *
 * The supervisor deliberately does very little:
 *  - starts one child per index, each with its own manifest, PXE store, and
 *    health port;
 *  - restarts a child that dies, with backoff, because the failure that matters
 *    (a crashed process holding five committed cards) is exactly the one the
 *    abandonment sweep needs a live process to resolve;
 *  - stops trying if a child dies immediately and repeatedly, since a
 *    misconfigured pool that respawns forever is worse than one that stops and
 *    says why.
 *
 * It does NOT coordinate matchmaking. Bots avoid stampeding a lone player by
 * reading `botsQueued`/`humansWaiting` from the relay, and the relay refuses to
 * pair two bots — both are enforced where the decision actually is, rather than
 * here where it would be advisory.
 */
import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

export interface PoolOptions {
  size: number;
  /** First identity index; the pool uses [startIndex, startIndex + size). */
  startIndex?: number;
  /** Base health port; child i listens on base + i. 0 disables. */
  healthPortBase?: number;
  entry?: string;
  spawnFn?: typeof spawn;
  log?: (msg: string) => void;
  /** A child that dies within this window counts as a startup failure. */
  minUptimeMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
}

interface Child {
  index: number;
  proc: ChildProcess;
  startedAt: number;
  restarts: number;
}

export class BotPool {
  private readonly children = new Map<number, Child>();
  private readonly log: (m: string) => void;
  private readonly entry: string;
  private readonly spawnFn: typeof spawn;
  private stopped = false;

  constructor(private readonly opts: PoolOptions) {
    this.log = opts.log ?? ((m: string) => console.log(`[arena-pool] ${m}`));
    this.spawnFn = opts.spawnFn ?? spawn;
    const here = dirname(fileURLToPath(import.meta.url));
    this.entry = opts.entry ?? resolve(here, 'index.js');
  }

  get indices(): number[] {
    const start = this.opts.startIndex ?? 0;
    return Array.from({ length: this.opts.size }, (_, i) => start + i);
  }

  /**
   * Fail BEFORE spawning anything if an identity is missing. A pool that starts
   * three of five bots and logs two stack traces is far harder to diagnose than
   * one that refuses and names the missing manifest.
   */
  verifyIdentities(artifactsDir: string): void {
    const missing = this.indices
      .map(i => ({ i, path: resolve(artifactsDir, `arena-bot-${i}.json`) }))
      .filter(({ path }) => !existsSync(path));
    if (missing.length > 0) {
      throw new Error(
        `Pool of ${this.opts.size} needs a provisioned identity per index. Missing:\n` +
        missing.map(m => `  index ${m.i}: ${m.path}`).join('\n') +
        `\nProvision each with a DISJOINT card range — token_ids are globally unique:\n` +
        `  npx tsx scripts/provision-arena-bot.ts --index <i> --cards 30 --offset <i*30>`,
      );
    }
  }

  start(): void {
    this.stopped = false;
    for (const index of this.indices) this.spawnChild(index, 0);
    this.log(`pool of ${this.opts.size} started (indices ${this.indices.join(', ')})`);
  }

  private spawnChild(index: number, restarts: number): void {
    if (this.stopped) return;
    const healthBase = this.opts.healthPortBase ?? 5175;
    const env = {
      ...process.env,
      ARENA_BOT_INDEX: String(index),
      // Each identity gets its own health port, or they race for one socket and
      // every bot after the first logs EADDRINUSE and serves nothing.
      ARENA_BOT_HEALTH_PORT: healthBase === 0 ? '0' : String(healthBase + index),
    };
    const proc = this.spawnFn('node', [this.entry], { env, stdio: 'inherit' });
    const child: Child = { index, proc, startedAt: Date.now(), restarts };
    this.children.set(index, child);

    proc.on('exit', (code, signal) => {
      this.children.delete(index);
      if (this.stopped) return;
      const uptime = Date.now() - child.startedAt;
      const quick = uptime < (this.opts.minUptimeMs ?? 30_000);
      const next = quick ? restarts + 1 : 0;
      const max = this.opts.maxRestarts ?? 5;

      if (quick && next > max) {
        // Respawning forever would bury the real error in a scroll of restarts.
        this.log(
          `index ${index} died after ${uptime}ms, ${next} times in a row (code ${code}, signal ${signal}) — ` +
          `giving up on it. Its cards stay committed until it runs again.`,
        );
        return;
      }
      const delay = this.opts.restartDelayMs ?? 5_000;
      this.log(`index ${index} exited (code ${code}, signal ${signal}) — restarting in ${delay}ms`);
      setTimeout(() => this.spawnChild(index, next), delay).unref?.();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const child of this.children.values()) child.proc.kill('SIGTERM');
    this.children.clear();
  }

  get running(): number {
    return this.children.size;
  }
}
