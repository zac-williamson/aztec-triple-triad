/**
 * Keep the testnet account pool stocked, so a run provisions its own players
 * instead of stopping for someone to do it by hand.
 *
 * Pool accounts are single-use and only valid for the deployment they were
 * minted against (playtestPool.ts), so the pool drains with every run and
 * empties outright on every redeploy or re-genesis. When a player is about to
 * launch and nothing usable is left, this runs the provisioner
 * (scripts/provision-playtest-accounts.ts) for the shortfall at fresh indices:
 * it bridges Fee Juice from the L1 treasury, deploys each account, mints its
 * starter cards and verifies them on-chain. All it needs is the treasury key the
 * provisioner already reads (~/.aztec-triad-private/treasury-l1-key.txt unless
 * TREASURY_L1_KEY / TREASURY_L1_KEY_FILE say otherwise) with Sepolia ETH in it.
 */
import { spawn } from 'child_process';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { ARTIFACTS_DIR, PLAYTEST_ACCOUNTS_PATH, PXE_URL, ROOT, readContractAddresses } from './env.js';
import { countClaimable, nextFreeIndex, type PoolEntry } from './playtestPool.js';

/** Sepolia RPC to bridge through when TESTNET_L1_RPC_URL is unset — the same
 *  public endpoint fund-fee-juice.ts defaults to. */
const DEFAULT_L1_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

/** Per-account budget: L1 mint + approve + deposit, up to 10 min for the
 *  L1->L2 message, then the deploy and mint transactions. ~4 min is typical. */
const PER_ACCOUNT_MS = 15 * 60 * 1000;

/** Provisioner output worth showing live; everything goes to the log file. */
const PROGRESS = /=== Provisioning account #|account (deployed|already deployed)|✓ verified|=== Done|^Pool:|failed|Error:/;

export function readPool(): PoolEntry[] {
  return existsSync(PLAYTEST_ACCOUNTS_PATH)
    ? (JSON.parse(readFileSync(PLAYTEST_ACCOUNTS_PATH, 'utf-8')) as PoolEntry[])
    : [];
}

/**
 * Make sure at least `min` unused accounts exist for the NFT under test,
 * provisioning `max(batch, shortfall)` more when they do not. Players come in
 * pairs, so callers top up a pair at a time rather than stalling twice.
 */
export async function ensurePoolAccounts(
  min: number,
  batch = min,
  log: (m: string) => void = (m) => console.log(`[pool] ${m}`),
): Promise<void> {
  const { nft } = readContractAddresses();
  const pool = readPool();
  const have = countClaimable(pool, nft);
  if (have >= min) return;

  const count = Math.max(batch, min - have);
  const start = nextFreeIndex(pool);
  log(
    `${have} unused account(s) for NFT ${nft.slice(0, 12)}…; provisioning ${count} from the ` +
      `treasury as #${start}..#${start + count - 1} (~4 min each)`,
  );
  await runProvisioner(start, count, log);

  const after = countClaimable(readPool(), nft);
  if (after < min) {
    throw new Error(
      `Provisioned ${count} account(s) but only ${after} are usable for NFT ${nft} — ` +
        `see the provision-*.log in ${ARTIFACTS_DIR}.`,
    );
  }
  log(`ready: ${after} unused account(s) for this deployment`);
}

function runProvisioner(start: number, count: number, log: (m: string) => void): Promise<void> {
  const logPath = resolve(ARTIFACTS_DIR, `provision-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const out = createWriteStream(logPath);
  const timeoutMs = count * PER_ACCOUNT_MS;
  return new Promise<void>((resolveRun, reject) => {
    const proc = spawn(
      'npx',
      ['tsx', 'scripts/provision-playtest-accounts.ts', '--start', String(start), '--count', String(count)],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AZTEC_PXE_URL: PXE_URL,
          TESTNET_L1_RPC_URL: process.env.TESTNET_L1_RPC_URL || DEFAULT_L1_RPC,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    for (const stream of [proc.stdout!, proc.stderr!]) {
      stream.pipe(out, { end: false });
      createInterface({ input: stream }).on('line', (line) => {
        if (PROGRESS.test(line.trim())) log(line.trim());
      });
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`provisioning ${count} account(s) timed out after ${timeoutMs / 60000} min — see ${logPath}`));
    }, timeoutMs);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      out.end();
      if (err) reject(err);
      else resolveRun();
    };
    proc.once('exit', (code) =>
      finish(code === 0 ? undefined : new Error(`provisioning exited with code ${code} — see ${logPath}`)));
    proc.once('error', (err) => finish(err));
  });
}
