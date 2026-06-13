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
import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import net from 'net';
import {
  ROOT, PXE_URL, NODE_PORT, ANVIL_PORT, BACKEND_PORT, FRONTEND_PORT,
  BACKEND_URL, FRONTEND_URL, ARTIFACTS_DIR, STACK_INFO_PATH,
  readContractAddresses, type StackInfo,
} from './env.js';

const BOOT_TIMEOUTS = {
  sandboxMs: 300_000,   // cold image pulls can be slow
  deployMs: 900_000,    // VK hashing + 8 txs on a fresh chain
  backendMs: 30_000,
  frontendMs: 120_000,  // first vite optimize pass is heavy (aztec deps)
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

  constructor() {
    this.logsDir = resolve(ARTIFACTS_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(this.logsDir, { recursive: true });
  }

  private spawnLogged(name: string, command: string, args: string[], opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }): ChildProcess {
    const logPath = resolve(this.logsDir, `${name}.log`);
    const out = createWriteStream(logPath);
    const proc = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout!.pipe(out);
    proc.stderr!.pipe(out);
    this.children.push({ name, proc });
    log(`${name} spawned (pid ${proc.pid}) → ${logPath}`);
    return proc;
  }

  /** Fail loudly if a stack port is already taken — no silent reuse. */
  async assertPortsFree(): Promise<void> {
    for (const [name, port] of [
      ['aztec node', NODE_PORT], ['anvil', ANVIL_PORT],
      ['backend', BACKEND_PORT], ['frontend', FRONTEND_PORT],
    ] as const) {
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

  async deployContracts(): Promise<void> {
    log('deploying contracts...');
    const logPath = resolve(this.logsDir, 'deploy.log');
    const out = createWriteStream(logPath);
    await new Promise<void>((resolveDeploy, reject) => {
      const proc = spawn('npx', ['tsx', 'scripts/deploy-contracts.ts'], {
        cwd: ROOT,
        env: { ...process.env, AZTEC_PXE_URL: PXE_URL, WS_PORT: String(BACKEND_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout!.pipe(out);
      proc.stderr!.pipe(out);
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`deploy-contracts.ts timed out after ${BOOT_TIMEOUTS.deployMs / 1000}s — see ${logPath}`));
      }, BOOT_TIMEOUTS.deployMs);
      proc.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolveDeploy();
        else reject(new Error(`deploy-contracts.ts exited with code ${code} — see ${logPath}`));
      });
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
    const proc = this.spawnLogged('frontend', 'npx', ['vite', '--port', String(FRONTEND_PORT), '--strictPort'], {
      cwd: resolve(ROOT, 'packages/frontend'),
      env: { VITE_TESTKIT: '1' },
    });
    await waitFor('frontend (vite)', () => httpOk(FRONTEND_URL), BOOT_TIMEOUTS.frontendMs, proc);
  }

  async bootAll(): Promise<StackInfo> {
    await this.assertPortsFree();
    await this.bootSandbox();
    await this.deployContracts();
    await this.bootBackend();
    await this.bootFrontend();
    const info: StackInfo = {
      pids: Object.fromEntries(this.children.map(c => [c.name, c.proc.pid])),
      addresses: readContractAddresses(),
      logsDir: this.logsDir,
      reused: false,
    };
    writeFileSync(STACK_INFO_PATH, JSON.stringify(info, null, 2));
    return info;
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
