#!/usr/bin/env npx tsx
/**
 * Sync the six VITE_* vars from packages/frontend/.env into the Vercel
 * project's Production environment, then trigger a fresh production build.
 *
 * Credentials live OUTSIDE the repo (so they never get committed):
 *   /Users/zac/aztec-triple-triad-ui/vercel_token.txt        # Vercel PAT
 *   /Users/zac/aztec-triple-triad-ui/vercel_project_id.txt   # project ID
 *
 * Overrides:
 *   VERCEL_TEAM_ID    (optional; needed for team-owned projects)
 *   WS_URL            (default wss://ws.aztec-arena.com)
 *
 * Usage:
 *   npx tsx scripts/sync-vercel-env.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const PARENT_DIR = resolve(ROOT_DIR, '..');

const TOKEN_FILE = resolve(PARENT_DIR, 'vercel_token.txt');
const PROJECT_ID_FILE = resolve(PARENT_DIR, 'vercel_project_id.txt');
const FRONTEND_ENV_FILE = resolve(ROOT_DIR, 'packages/frontend/.env');

const WS_URL = process.env.WS_URL || 'wss://ws.aztec-arena.com';
const TEAM_ID = process.env.VERCEL_TEAM_ID || '';

function readTrim(path: string): string {
  return readFileSync(path, 'utf8').trim();
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

const token = readTrim(TOKEN_FILE);
const projectId = readTrim(PROJECT_ID_FILE);
const teamQuery = TEAM_ID ? `?teamId=${encodeURIComponent(TEAM_ID)}` : '';

const frontendEnv = parseDotenv(FRONTEND_ENV_FILE);

const desired: Record<string, string> = {
  VITE_AZTEC_PXE_URL: frontendEnv.VITE_AZTEC_PXE_URL ?? 'https://rpc.testnet.aztec-labs.com',
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

async function upsertEnvVar(key: string, value: string, existing?: VercelEnvVar): Promise<void> {
  const body = {
    key,
    value,
    type: 'plain' as EnvVarKind,
    target: ['production', 'preview', 'development'],
  };
  if (existing) {
    await vercelFetch(`/v9/projects/${projectId}/env/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ value, type: 'plain', target: body.target }),
    });
    console.log(`  updated ${key}`);
  } else {
    await vercelFetch(`/v10/projects/${projectId}/env`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    console.log(`  created ${key}`);
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

  console.log('Fetching existing env vars...');
  const existing = await listEnvVars();
  const byKey = new Map(existing.map(e => [e.key, e]));

  console.log('Syncing env vars:');
  for (const [key, value] of Object.entries(desired)) {
    await upsertEnvVar(key, value, byKey.get(key));
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
