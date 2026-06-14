/**
 * Stack orchestrator — boots and tears down the full local stack:
 *   1. Aztec sandbox (start-sandbox.sh: anvil + L2 node, fresh data)
 *   2. Contract deploy (scripts/deploy-contracts.ts → frontend/.env)
 *   3. Backend WS server (in-memory store — fresh process = clean state)
 *   4. Frontend Vite dev server with VITE_TESTKIT=1
 *
 * Children are spawned detached (own process group) so teardown can kill the
 * whole tree — `aztec start` forks anvil and node workers.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import net from 'net';
import {
  ROOT, PXE_URL, NODE_PORT, ANVIL_PORT, BACKEND_PORT, FRONTEND_PORT,
  BACKEND_URL, FRONTEND_URL, ARTIFACTS_DIR, BROWSER_REGISTRY_PATH, TESTNET,
  readContractAddresses, type StackInfo, type StackMode,
} from './env.js';

const BOOT_TIMEOUTS = {
  sandboxMs: 300_000,   // cold image pulls can be slow
  deployMs: 900_000,    // VK hashing + 8 txs on a fresh chain
  backendMs: 30_000,
  optimizeMs: 300_000,  // cold pre-bundle of the @aztec/three dep graph
  frontendMs: 120_000,
};

function log(msg: string): void {
  console.log(`[stack] ${new Date().toISOString()} ${msg}`);
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (used: boolean) => { sock.destroy(); resolvePort(used); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
  child?: ChildProcess,
): Promise<void> {
  const start = Date.now();
  let exited: string | null = null;
  child?.once('exit', (code, signal) => { exited = `exit code=${code} signal=${signal}`; });
  while (Date.now() - start < timeoutMs) {
    if (exited) throw new Error(`${what}: process died while booting (${exited}) — see its log`);
    try {
      if (await probe()) {
        log(`${what} ready (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        return;
      }
    } catch { /* probe not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`${what}: not ready after ${timeoutMs / 1000}s`);
}

async function nodeIsUp(): Promise<boolean> {
  const res = await fetch(PXE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'node_getBlockNumber', params: [], id: 1 }),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return false;
  const body = await res.json() as { result?: unknown };
  return body.result !== undefined && Number(body.result) >= 1;
}

async function httpOk(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}

export class Stack {
  private children: { name: string; proc: ChildProcess }[] = [];
  readonly logsDir: string;

  constructor(private readonly mode: StackMode, private readonly infoPath: string) {
    this.logsDir = resolve(ARTIFACTS_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(this.logsDir, { recursive: true });
  }

  /**
   * Spawn a detached child with stdio bound directly to its log file.
   * Never pipe a detached child through this process: when the parent exits
   * the pipe closes and the child dies on its next write (EPIPE) — this is
   * exactly how the sandbox died out from under the first campaign run.
   */
  private spawnLogged(name: string, command: string, args: string[], opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }): ChildProcess {
    const logPath = resolve(this.logsDir, `${name}.log`);
    const fd = openSync(logPath, 'a');
    const proc = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd); // child holds its own duplicate
    this.children.push({ name, proc });
    this.writeInfo(); // record pids incrementally so a mid-boot failure can still be cleaned up
    log(`${name} spawned (pid ${proc.pid}) → ${logPath}`);
    return proc;
  }

  private writeInfo(addresses?: StackInfo['addresses']): StackInfo {
    const info: StackInfo = {
      mode: this.mode,
      pids: Object.fromEntries(this.children.map(c => [c.name, c.proc.pid])),
      addresses: addresses ?? null,
      logsDir: this.logsDir,
    };
    writeFileSync(this.infoPath, JSON.stringify(info, null, 2));
    return info;
  }

  /** Fail loudly if a stack port is already taken — no silent reuse. */
  async assertPortsFree(): Promise<void> {
    // Testnet mode only owns the local vite (3000); the node/anvil/backend are
    // remote (live testnet + live ws relay), so don't probe their local ports.
    const ports = TESTNET
      ? ([['frontend', FRONTEND_PORT]] as const)
      : ([
          ['aztec node', NODE_PORT], ['anvil', ANVIL_PORT],
          ['backend', BACKEND_PORT], ['frontend', FRONTEND_PORT],
        ] as const);
    for (const [name, port] of ports) {
      if (await portInUse(port)) {
        throw new Error(
          `Port ${port} (${name}) is already in use. The harness owns the full stack — ` +
          `stop the other process, or set PLAYTEST_REUSE_STACK=1 to attach to a running stack.`,
        );
      }
    }
  }

  async bootSandbox(): Promise<void> {
    const proc = this.spawnLogged('sandbox', 'bash', ['start-sandbox.sh'], { cwd: ROOT });
    await waitFor('sandbox (node producing blocks)', nodeIsUp, BOOT_TIMEOUTS.sandboxMs, proc);
  }

  /** Run a one-shot command to completion (logged), rejecting on nonzero exit or timeout. */
  private runToCompletion(name: string, command: string, args: string[], opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    timeoutMs: number;
  }): Promise<void> {
    const logPath = resolve(this.logsDir, `${name}.log`);
    const fd = openSync(logPath, 'a');
    return new Promise<void>((resolveRun, reject) => {
      const proc = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', fd, fd],
      });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`${name} timed out after ${opts.timeoutMs / 1000}s — see ${logPath}`));
      }, opts.timeoutMs);
      const finish = (err?: Error) => { clearTimeout(timer); closeSync(fd); err ? reject(err) : resolveRun(); };
      proc.once('exit', code => finish(code === 0 ? undefined : new Error(`${name} exited with code ${code} — see ${logPath}`)));
      proc.once('error', err => finish(err));
    });
  }

  async deployContracts(): Promise<void> {
    log('deploying contracts...');
    await this.runToCompletion('deploy', 'npx', ['tsx', 'scripts/deploy-contracts.ts'], {
      cwd: ROOT,
      env: { AZTEC_PXE_URL: PXE_URL, WS_PORT: String(BACKEND_PORT) },
      timeoutMs: BOOT_TIMEOUTS.deployMs,
    });
    const addrs = readContractAddresses();
    log(`deployed: game=${addrs.game.slice(0, 14)}… nft=${addrs.nft.slice(0, 14)}… token=${addrs.token.slice(0, 14)}…`);
  }

  async bootBackend(): Promise<void> {
    // No REDIS_URL → in-memory store: a fresh process IS the clean slate.
    const proc = this.spawnLogged('backend', 'npx', ['tsx', 'src/server.ts'], {
      cwd: resolve(ROOT, 'packages/backend'),
      env: { WS_PORT: String(BACKEND_PORT), REDIS_URL: undefined },
    });
    await waitFor('backend (/health)', () => httpOk(`${BACKEND_URL}/health`), BOOT_TIMEOUTS.backendMs, proc);
  }

  async bootFrontend(): Promise<void> {
    // Pre-bundle the dep graph BEFORE serving. On a cold cache (every first
    // boot after an SDK bump) the dev server optimizes the dynamically-imported
    // @aztec deps in the BACKGROUND while already serving; if the test's first
    // page load wins that race, Vite force-reloads the page mid-onboarding and
    // restarts the wallet deploy+mint, which never finishes inside the budget
    // (the 4.3.1 acceptance-run break). A completed `vite optimize` under the
    // same env leaves a warm cache, so the server starts reload-free.
    const frontendCwd = resolve(ROOT, 'packages/frontend');
    // Testnet: serve the SAME app against the deployed testnet contracts + the
    // live ws relay. `--mode testnet` loads .env.testnet (PXE + verified
    // addresses + AZTEC_ENABLED); process.env VITE_* take priority over .env
    // files, so these override the file's stale localhost VITE_WS_URL and add
    // the faucet + testkit. Local mode is unchanged (just VITE_TESTKIT).
    const modeArgs = TESTNET ? ['--mode', 'testnet'] : [];
    const viteEnv: Record<string, string | undefined> = TESTNET
      ? { VITE_TESTKIT: '1', VITE_WS_URL: 'wss://ws.aztec-arena.com', VITE_FAUCET_URL: 'https://ws.aztec-arena.com' }
      : { VITE_TESTKIT: '1' };
    // Sync public/ circuit + contract artifacts from target/ before serving.
    // The dev server serves public/ as-is (no build step), and committed public
    // copies can lag target/ after a contracts/circuits change (seen after the
    // C2 merge) — a stale ABI would mismatch the deployed contracts.
    log('syncing frontend public artifacts from target...');
    await this.runToCompletion('copy-artifacts', 'bash',
      ['-c', 'npm run copy-circuits && npm run copy-contracts'],
      { cwd: ROOT, timeoutMs: 60_000 });
    log(`pre-optimizing frontend deps (warm vite cache)${TESTNET ? ' [testnet]' : ''}...`);
    await this.runToCompletion('frontend-optimize', 'npx', ['vite', 'optimize', ...modeArgs], {
      cwd: frontendCwd,
      env: viteEnv,
      timeoutMs: BOOT_TIMEOUTS.optimizeMs,
    });
    const proc = this.spawnLogged('frontend', 'npx', ['vite', '--port', String(FRONTEND_PORT), '--strictPort', ...modeArgs], {
      cwd: frontendCwd,
      env: viteEnv,
    });
    await waitFor('frontend (vite)', () => httpOk(FRONTEND_URL), BOOT_TIMEOUTS.frontendMs, proc);
  }

  async bootAll(): Promise<StackInfo> {
    await this.assertPortsFree();
    if (TESTNET) {
      // The chain (testnet) and ws relay (ws.aztec-arena.com) are already live;
      // only the local vite is ours. Addresses come from .env.testnet.
      log('testnet mode — using live testnet + live ws relay; booting local vite only');
      await this.bootFrontend();
      return this.writeInfo(readContractAddresses());
    }
    await this.bootSandbox();
    await this.deployContracts();
    await this.bootBackend();
    await this.bootFrontend();
    return this.writeInfo(readContractAddresses());
  }
}

/** Kill a detached child's whole process group, escalating to SIGKILL. */
export async function killProcessGroup(pid: number, name: string): Promise<void> {
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); return true; } catch { return false; }
  };
  if (!signal('SIGTERM')) return; // already gone
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    try { process.kill(-pid, 0); } catch { log(`${name} stopped`); return; }
  }
  log(`${name} did not stop on SIGTERM — sending SIGKILL`);
  signal('SIGKILL');
}

// ── Per-player browser PID registry ──────────────────────────────────────────
// Playwright launches each campaign browser detached (own process group) and
// kills it only via exit/SIGINT/SIGTERM hooks; a SIGKILLed worker orphans them.
// We record their pids so teardown can kill the leaked process GROUPS — the same
// `process.kill(-pid)` Playwright itself uses — even when its hooks never ran.

interface BrowserEntry { pid: number; name: string }

/**
 * PIDs of every currently-alive Chromium process-GROUP LEADER that looks like a
 * Playwright-managed browser (its argv0 lives under the playwright browser
 * cache — so the user's own Chrome, whose path does not, is never matched).
 * Playwright launches each browser detached as its own group leader (pid==pgid);
 * its renderer/GPU helpers share that group but are not leaders, so killing the
 * leader's group takes them too. `@playwright/test`'s client Browser exposes no
 * pid, so the campaign diffs this set across a launch to learn the new pid.
 */
export function playwrightChromiumLeaders(): Set<number> {
  let out = '';
  try { out = execFileSync('ps', ['-Ao', 'pid=,pgid=,command='], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }); }
  catch { return new Set(); }
  const pids = new Set<number>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), pgid = Number(m[2]), cmd = m[3];
    if (pid === pgid && /ms-playwright|playwright|chrome-mac|chrome-linux|chromium/i.test(cmd)) pids.add(pid);
  }
  return pids;
}

function readBrowserRegistry(): BrowserEntry[] {
  if (!existsSync(BROWSER_REGISTRY_PATH)) return [];
  try { return JSON.parse(readFileSync(BROWSER_REGISTRY_PATH, 'utf-8')) as BrowserEntry[]; }
  catch { return []; }
}

/** Record a launched browser's main pid (serial single-worker → no write race). */
export function registerBrowser(pid: number, name: string): void {
  const list = readBrowserRegistry();
  list.push({ pid, name });
  writeFileSync(BROWSER_REGISTRY_PATH, JSON.stringify(list, null, 2));
}

/** Drop a pid on clean dispose so teardown never targets a recycled pid. */
export function deregisterBrowser(pid: number): void {
  const list = readBrowserRegistry().filter(e => e.pid !== pid);
  if (list.length) writeFileSync(BROWSER_REGISTRY_PATH, JSON.stringify(list, null, 2));
  else rmSync(BROWSER_REGISTRY_PATH, { force: true });
}

/** Full command path of a pid (empty if gone) — guards against pid recycling. */
function processCommand(pid: number): string {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim(); }
  catch { return ''; }
}

/**
 * Kill any registered browser still alive (the SIGKILLed-worker leak case),
 * then clear the registry. A comm guard ensures a since-recycled pid can never
 * take out an unrelated process group: we only kill if the pid still looks like
 * a Chromium. Returns how many leaked browsers it actually killed.
 */
export async function killRegisteredBrowsers(): Promise<number> {
  const list = readBrowserRegistry();
  let killed = 0;
  for (const { pid, name } of list) {
    const cmd = processCommand(pid);
    if (!cmd) continue; // gone already (clean dispose or died)
    if (!/chrom|headless|playwright/i.test(cmd)) {
      log(`browser ${name} pid ${pid} is now '${cmd.slice(0, 40)}…' (recycled) — not killing`);
      continue;
    }
    log(`killing LEAKED browser ${name} (pid ${pid}) — process group`);
    await killProcessGroup(pid, `browser-${name}`);
    killed++;
  }
  rmSync(BROWSER_REGISTRY_PATH, { force: true });
  return killed;
}
