#!/usr/bin/env npx tsx
/**
 * Sync the six VITE_* vars from packages/frontend/.env.testnet into the Vercel
 * project's Production environment, then trigger a fresh production build.
 *
 * Reads .env.testnet, NOT .env: `.env` is rewritten by whichever deploy script
 * ran last — a local-sandbox `deploy-contracts.ts` run leaves LOCALHOST values
 * there, and an unguarded sync would push them straight to production (nearly
 * happened once). `.env.testnet` is only ever written by deploy-testnet.ts.
 * A refuse-localhost guard backstops this regardless of the file used.
 *
 * Credentials live OUTSIDE the repo (so they never get committed):
 *   ~/.aztec-triad-private/vercel-token.txt                  # Vercel PAT
 *   (legacy fallback: <repo-parent>/vercel_token.txt)
 *   /Users/zac/aztec-triple-triad-ui/vercel_project_id.txt   # project ID
 *
 * Overrides:
 *   VERCEL_TEAM_ID    (optional; needed for team-owned projects)
 *   WS_URL            (default wss://ws.aztec-arena.com)
 *   --env-file=PATH   (read a different dotenv file)
 *   --sync-only       (update env vars but skip the redeploy)
 *
 * Usage:
 *   npx tsx scripts/sync-vercel-env.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const PARENT_DIR = resolve(ROOT_DIR, '..');

const TOKEN_FILES = [
  resolve(homedir(), '.aztec-triad-private/vercel-token.txt'),
  resolve(PARENT_DIR, 'vercel_token.txt'), // legacy location
];
const PROJECT_ID_FILE = resolve(PARENT_DIR, 'vercel_project_id.txt');
const envFileArg = process.argv.find(a => a.startsWith('--env-file='))?.slice('--env-file='.length);
const SYNC_ONLY = process.argv.includes('--sync-only');
const FRONTEND_ENV_FILE = envFileArg
  ? resolve(envFileArg)
  : resolve(ROOT_DIR, 'packages/frontend/.env.testnet');

const WS_URL = process.env.WS_URL || 'wss://ws.aztec-arena.com';
const TEAM_ID = process.env.VERCEL_TEAM_ID || '';

function readTrim(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

function readToken(): string {
  for (const f of TOKEN_FILES) {
    if (existsSync(f)) return readTrim(f);
  }
  throw new Error(`No Vercel token found; looked in:\n  ${TOKEN_FILES.join('\n  ')}`);
}

function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

type EnvVarKind = 'plain' | 'encrypted';

interface VercelEnvVar {
  id: string;
  key: string;
  value: string;
  type: EnvVarKind;
  target: string[];
}

const token = readToken();
const projectId = readTrim(PROJECT_ID_FILE);

const frontendEnv = parseDotenv(FRONTEND_ENV_FILE);

const desired: Record<string, string> = {
  VITE_AZTEC_PXE_URL: frontendEnv.VITE_AZTEC_PXE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com',
  VITE_NFT_CONTRACT_ADDRESS: frontendEnv.VITE_NFT_CONTRACT_ADDRESS,
  VITE_GAME_CONTRACT_ADDRESS: frontendEnv.VITE_GAME_CONTRACT_ADDRESS,
  VITE_TOKEN_CONTRACT_ADDRESS: frontendEnv.VITE_TOKEN_CONTRACT_ADDRESS,
  VITE_AZTEC_ENABLED: frontendEnv.VITE_AZTEC_ENABLED ?? 'true',
  VITE_WS_URL: WS_URL,
};

for (const [k, v] of Object.entries(desired)) {
  if (!v) {
    throw new Error(`Missing value for ${k} in ${FRONTEND_ENV_FILE}`);
  }
  // Production guard: a localhost value here means the source dotenv was
  // written by a LOCAL deploy — syncing it would take prod down.
  if (/localhost|127\.0\.0\.1/i.test(v)) {
    throw new Error(
      `${k}=${v} looks like a local-sandbox value (from ${FRONTEND_ENV_FILE}). ` +
      'Refusing to sync it to production. Run deploy-testnet.ts first or pass --env-file.',
    );
  }
}

async function vercelFetch(path: string, init: RequestInit = {}): Promise<any> {
  const url = `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}${TEAM_ID ? `teamId=${encodeURIComponent(TEAM_ID)}` : ''}`.replace(/[?&]$/, '');
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Vercel API ${res.status} ${res.statusText} for ${path}:\n${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function listEnvVars(): Promise<VercelEnvVar[]> {
  const data = await vercelFetch(`/v9/projects/${projectId}/env`);
  return (data.envs || []) as VercelEnvVar[];
}

const ALL_TARGETS = ['production', 'preview', 'development'];

/**
 * Vercel stores ONE RECORD PER TARGET SPLIT for the same key (this project has
 * e.g. a `production` record and a `preview,development` record per var). The
 * old version collapsed the list by key and PATCHed one record with the full
 * target array — leaving the sibling stale (prod serving the old value) or
 * 400-ing with "already exists". Instead: PATCH the VALUE ONLY on every
 * existing record (its target split is preserved untouched), and POST a new
 * record only for targets no record covers.
 */
async function upsertEnvVar(key: string, value: string, existing: VercelEnvVar[]): Promise<void> {
  for (const record of existing) {
    await vercelFetch(`/v9/projects/${projectId}/env/${record.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ value }),
    });
    console.log(`  updated ${key} [${record.target.join(',')}]`);
  }
  const covered = new Set(existing.flatMap(r => r.target));
  const missing = ALL_TARGETS.filter(t => !covered.has(t));
  if (missing.length > 0) {
    await vercelFetch(`/v10/projects/${projectId}/env`, {
      method: 'POST',
      body: JSON.stringify({ key, value, type: 'plain' as EnvVarKind, target: missing }),
    });
    console.log(`  created ${key} [${missing.join(',')}]`);
  }
}

async function getLatestProductionDeployment(): Promise<any | null> {
  const data = await vercelFetch(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1&state=READY`);
  return (data.deployments && data.deployments[0]) || null;
}

async function redeploy(): Promise<string> {
  const latest = await getLatestProductionDeployment();
  if (!latest || !latest.meta) {
    // Fall back to any latest production deployment (even not READY) to steal gitSource
    const anyLatest = await vercelFetch(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`);
    const d = anyLatest.deployments && anyLatest.deployments[0];
    if (!d) throw new Error('No prior production deployment found — push to git to trigger the first build.');
    return triggerFromGitRef(d);
  }
  return triggerFromGitRef(latest);
}

async function triggerFromGitRef(prior: any): Promise<string> {
  const meta = prior.meta || {};
  const type = (meta.githubCommitRepo ? 'github' : meta.gitlabCommitProjectId ? 'gitlab' : meta.bitbucketCommitRepoSlug ? 'bitbucket' : 'github');
  const ref = meta.githubCommitRef || meta.gitlabCommitRef || meta.bitbucketCommitRef || 'testnet';
  const repoId = meta.githubRepoId || meta.gitlabProjectId || meta.bitbucketRepoUuid;
  if (!repoId) {
    throw new Error(`Cannot find repo id in prior deployment meta: ${JSON.stringify(meta)}`);
  }
  const body = {
    name: prior.name || 'aztec-arena',
    project: projectId,
    target: 'production',
    gitSource: {
      type,
      ref,
      repoId: typeof repoId === 'string' && /^\d+$/.test(repoId) ? Number(repoId) : repoId,
    },
  };
  const deployment = await vercelFetch(`/v13/deployments?forceNew=1`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return deployment.url || deployment.id || '(unknown)';
}

async function main() {
  console.log(`Vercel project: ${projectId}`);
  if (TEAM_ID) console.log(`Team: ${TEAM_ID}`);

  console.log(`Env source: ${FRONTEND_ENV_FILE}`);
  console.log('Fetching existing env vars...');
  const existing = await listEnvVars();
  // One key can have SEVERAL records (one per target split) — keep them all.
  const byKey = new Map<string, VercelEnvVar[]>();
  for (const e of existing) {
    byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  }

  console.log('Syncing env vars:');
  for (const [key, value] of Object.entries(desired)) {
    await upsertEnvVar(key, value, byKey.get(key) ?? []);
  }

  if (SYNC_ONLY) {
    console.log('\n--sync-only: skipping redeploy.');
    return;
  }
  console.log('\nTriggering production redeploy...');
  const deployedUrl = await redeploy();
  console.log(`Deployment queued: https://${deployedUrl.replace(/^https?:\/\//, '')}`);
  console.log('Watch the build at https://vercel.com/dashboard');
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
