#!/usr/bin/env npx tsx
/**
 * Deploy Triple Triad contracts to the Aztec testnet.
 *
 * Unlike the local deploy script, this:
 *  - Uses Fee Juice directly (no SponsoredFPC on testnet)
 *  - Accepts a pre-funded deployer account via env vars
 *  - Connects to the public testnet RPC
 *
 * Prerequisites:
 *   1. Get Fee Juice from the bridge https://bridge.aztec-kit.anothercoffeefor.me/ (select Testnet)
 *   2. Set env vars for your funded deployer account:
 *      export AZTEC_PXE_URL=https://v5.testnet.rpc.aztec-labs.com
 *      export DEPLOYER_SECRET=0x...    # Fr hex from aztec-wallet
 *      export DEPLOYER_SALT=0x...      # Fr hex from aztec-wallet
 *      export DEPLOYER_SIGNING_KEY=0x... # GrumpkinScalar hex
 *
 *   Or to create a fresh deployer (you'll need to fund it before contract deploys):
 *      npx tsx scripts/deploy-testnet.ts --create-account
 *
 * Usage:
 *   npx tsx scripts/deploy-testnet.ts                    # Deploy all contracts
 *   npx tsx scripts/deploy-testnet.ts --create-account   # Just create + print deployer address
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { NO_FROM } from '@aztec/aztec.js/account';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

import {
  bridgeFeeJuice,
  serializeClaim,
  deserializeClaim,
  getStoredClaim,
  loadClaimStore,
  putStoredClaim,
  markClaimConsumed,
  claimStorePath,
  readFunderKey,
  type FeeJuiceClaim,
} from './lib/feeJuiceBridge';
import { headroomMaxFeesPerGas } from './lib/feeSettings';

const PXE_URL = process.env.AZTEC_PXE_URL || 'https://v5.testnet.rpc.aztec-labs.com';
const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');

// ====================== Helpers ======================

async function loadContractArtifact(name: string) {
  const path = resolve(ROOT_DIR, `packages/contracts/target/${name}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const { loadContractArtifact: load } = await import('@aztec/aztec.js/abi');
  return load(raw);
}

function loadCircuitArtifact(name: string) {
  const path = resolve(ROOT_DIR, `circuits/target/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function bigintToBuffer32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, '0');
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

function bufferToHex(buf: Uint8Array): string {
  return '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeVkHash(api: any, vkBuf: Uint8Array): Promise<string> {
  const vkFields: string[] = [];
  for (let i = 0; i < vkBuf.length; i += 32) {
    const chunk = vkBuf.slice(i, i + 32);
    let hex = '0x';
    for (let j = 0; j < chunk.length; j++) hex += chunk[j].toString(16).padStart(2, '0');
    vkFields.push(hex);
  }
  const inputBuffers = vkFields.map((f) => bigintToBuffer32(BigInt(f)));
  const result = await (api as any).poseidon2Hash({ inputs: inputBuffers });
  return bufferToHex(result.hash);
}

/**
 * Get a Fee Juice claim to pay for the deployer account's own deployment.
 * Prefers a persisted, unconsumed claim (from scripts/fund-testnet.ts). If none
 * exists and treasury creds are in the env, bridges one inline and persists it.
 * Otherwise throws with the exact command to run.
 */
async function obtainDeployerClaim(node: any, deployerAddress: string): Promise<FeeJuiceClaim> {
  const storePath = claimStorePath();
  const stored = getStoredClaim(loadClaimStore(storePath), deployerAddress);
  if (stored && stored.status === 'pending') {
    console.log(`\nUsing persisted Fee Juice claim for deployer (amount ${stored.claimAmount}).`);
    return deserializeClaim(stored, Fr);
  }
  if (stored && stored.status === 'consumed') {
    console.log('\nPersisted claim already consumed; bridging a fresh one.');
  }

  const l1RpcUrl = process.env.TESTNET_L1_RPC_URL;
  if (!l1RpcUrl || !(process.env.TREASURY_L1_KEY || process.env.TREASURY_L1_KEY_FILE)) {
    throw new Error(
      `No Fee Juice claim for deployer ${deployerAddress}, and no treasury creds to bridge one.\n` +
        `  Fund it first:  npx tsx scripts/fund-testnet.ts ${deployerAddress}\n` +
        `  Or set TESTNET_L1_RPC_URL + TREASURY_L1_KEY (or TREASURY_L1_KEY_FILE) to bridge inline.`,
    );
  }

  console.log('\nBridging a Fee Juice claim for the deployer inline...');
  const claim = await bridgeFeeJuice({
    node,
    l1RpcUrl,
    funderKey: readFunderKey(),
    l2Address: deployerAddress,
    log: (m) => console.log(`  ${m}`),
    messageWaitSeconds: process.env.MESSAGE_WAIT_SECONDS ? Number(process.env.MESSAGE_WAIT_SECONDS) : 600,
  });
  putStoredClaim(storePath, deployerAddress, serializeClaim(deployerAddress, claim, new Date().toISOString()));
  return claim;
}

// ====================== Main ======================

async function main() {
  const createAccountOnly = process.argv.includes('--create-account');
  const skipAccount = process.argv.includes('--skip-account');

  // Resolve the deployer keys up front (before the slow compile) so a real
  // deploy fails FAST and LOUD if its keys are missing. NO hardcoded default:
  // two operators relying on a shared default would deploy to the same account
  // and collide (no-silent-fallback rule). --create-account mints a FRESH
  // random account and prints its keys to re-run with.
  let secretFr: InstanceType<typeof Fr>;
  let saltFr: InstanceType<typeof Fr>;
  let signingKey: InstanceType<typeof GrumpkinScalar>;

  if (createAccountOnly) {
    secretFr = Fr.random();
    saltFr = Fr.random();
    signingKey = GrumpkinScalar.random();
  } else {
    const { DEPLOYER_SECRET, DEPLOYER_SALT, DEPLOYER_SIGNING_KEY } = process.env;
    if (!DEPLOYER_SECRET || !DEPLOYER_SALT || !DEPLOYER_SIGNING_KEY) {
      throw new Error(
        'A real deploy requires DEPLOYER_SECRET, DEPLOYER_SALT and DEPLOYER_SIGNING_KEY in the env.\n' +
          '  Create a fresh deployer:  npx tsx scripts/deploy-testnet.ts --create-account\n' +
          '  then re-run with the printed keys. There is no shared default key — two\n' +
          '  operators relying on one would deploy to the same account and collide.',
      );
    }
    secretFr = Fr.fromHexString(DEPLOYER_SECRET);
    saltFr = Fr.fromHexString(DEPLOYER_SALT);
    signingKey = GrumpkinScalar.fromHexString(DEPLOYER_SIGNING_KEY);
  }

  // Refuse to compile a mutated contract.
  //
  // scripts/audit/mutate.mjs holds security-critical source in a deliberately
  // broken state for minutes at a time — one assertion replaced by
  // `assert(true);` — and the step below compiles whatever is on disk and ships
  // it. A deploy launched during a sweep, or after one that was killed without
  // restoring, would put a contract on chain with a protocol rule silently
  // removed, and nothing downstream would notice: it compiles, it deploys, its
  // tests are not run here, and the missing check only shows up when somebody
  // exploits it.
  //
  // This is the last point where that is catchable, so it is checked here and
  // not left to the operator remembering.
  {
    const { readdirSync: rd, statSync: st } = await import('fs');
    const mutated: string[] = [];
    const walk = (dir: string) => {
      for (const name of rd(dir)) {
        if (['target', 'node_modules', '.git'].includes(name)) continue;
        const full = resolve(dir, name);
        if (st(full).isDirectory()) walk(full);
        else if (full.endsWith('.nr')
          && readFileSync(full, 'utf8').split('\n').some(l => /^\s*assert\(true\);\s*$/.test(l))) {
          mutated.push(full);
        }
      }
    };
    walk(resolve(ROOT_DIR, 'packages/contracts'));
    walk(resolve(ROOT_DIR, 'circuits'));
    if (mutated.length) {
      throw new Error(
        'Refusing to deploy: neutered assertion(s) found in\n  ' + mutated.join('\n  ') +
        '\nThis is scripts/audit/mutate.mjs mid-sweep, or the wreckage of one that was ' +
        'killed.\nLet the sweep finish, or restore from /tmp/mutate-<target>.bak — ' +
        'NOT with git checkout,\nwhich takes any uncommitted work in the file with it.',
      );
    }
  }

  // Compile contracts first
  console.log('=== Compiling Contracts ===');
  const { execSync } = await import('child_process');
  execSync('aztec compile', {
    cwd: resolve(ROOT_DIR, 'packages/contracts'),
    stdio: 'inherit',
  });
  // Copy fresh artifacts to frontend
  const { cpSync } = await import('fs');
  const contractsDir = resolve(ROOT_DIR, 'packages/contracts/target');
  const frontendDir = resolve(ROOT_DIR, 'packages/frontend/public/contracts');
  for (const name of ['arena_token-ArenaToken', 'triple_triad_nft-TripleTriadNFT', 'triple_triad_game-TripleTriadGame']) {
    cpSync(`${contractsDir}/${name}.json`, `${frontendDir}/${name}.json`);
  }

  // packages/frontend/public/contracts is TRACKED, and it is what the browser
  // fetches at runtime to register the contracts. Refreshing it on disk does
  // nothing for the Vercel build, which runs from the repo — so an uncommitted
  // refresh ships the PREVIOUS deployment's ABI against the new contracts, and
  // the browser fails with "No artifact registered for contract class ..." at
  // the first transaction. Every new player is blocked; nobody who already has
  // a session notices.
  //
  // It is invisible from the JS bundle, which carries the calling code while the
  // ABI is a separate fetched JSON — so "the bundle has the new function names"
  // is not evidence the artifact matches. Say so here, loudly, because the
  // symptom appears long after the deploy that caused it.
  console.log('');
  console.log('!'.repeat(72));
  console.log('!!  COMMIT packages/frontend/public/contracts/ — it is tracked, and the');
  console.log('!!  deployed site serves whatever is COMMITTED there, not what is on disk.');
  console.log('!!  Without it the browser cannot register these contracts and every new');
  console.log('!!  player is blocked at their first transaction.');
  console.log('!'.repeat(72));
  console.log('');
  console.log('Compilation complete. Artifacts copied to frontend.\n');

  console.log('=== Triple Triad Testnet Deployment ===');
  console.log(`Connecting to ${PXE_URL}...`);

  const node = createAztecNodeClient(PXE_URL);
  // Testnet requires real proofs — enable the prover in the embedded PXE
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });

  console.log('Waiting for PXE sync...');
  await new Promise(r => setTimeout(r, 8000));

  const deployerAccount = await wallet.createSchnorrAccount(secretFr, saltFr, signingKey);
  const deployerAddress = deployerAccount.address;

  console.log(`\nDeployer address: ${deployerAddress.toString()}`);

  if (createAccountOnly) {
    // Only the create path echoes the secret material — intentionally, so the
    // operator can capture it. A real deploy never logs the keys it read.
    console.log('\n=== Fresh Account Created (keys are NOT persisted — save them) ===');
    console.log(`  Secret:      ${secretFr.toString()}`);
    console.log(`  Salt:        ${saltFr.toString()}`);
    console.log(`  Signing key: ${signingKey.toString()}`);
    console.log('\nFund it, then deploy with those keys:');
    console.log(`  DEPLOYER_SECRET=${secretFr.toString()} DEPLOYER_SALT=${saltFr.toString()} DEPLOYER_SIGNING_KEY=${signingKey.toString()} npx tsx scripts/deploy-testnet.ts`);
    console.log('\nFunding options:');
    console.log(`  npx tsx scripts/fund-testnet.ts ${deployerAddress.toString()}   (one-key treasury bridge)`);
    console.log('  or the Fee Juice bridge: https://bridge.aztec-kit.anothercoffeefor.me/ (select Testnet)');
    return;
  }

  // Testnet: no SponsoredFPC, use Fee Juice directly (default payment method).
  // Cap maxFeesPerGas with headroom over the current L2 base fee (see
  // scripts/lib/feeSettings.ts) so a rising base fee between estimation and
  // inclusion doesn't reject the tx. Computed fresh per send. Async because it
  // queries the node for the current min fee — call sites use `await sendAs(...)`.
  const sendAs = async (addr: any) => ({
    from: addr,
    fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
    wait: { timeout: 600 },
  });

  // Deploy the deployer account (skip if already deployed or --skip-account).
  // GAP FIX: on testnet there is no SponsoredFPC, and a brand-new account has no
  // Fee Juice balance to pay for its own deployment. We claim bridged Fee Juice
  // in the SAME tx via FeeJuicePaymentMethodWithClaim — the canonical fresh-
  // account-init flow. The claim comes from the persisted store (run
  // scripts/fund-testnet.ts first) or, if treasury creds are in the env, is
  // bridged inline here. After the deploy lands, the account holds the claimed
  // Fee Juice balance and pays for the contract deploys natively below.
  if (skipAccount) {
    console.log('\nSkipping account deployment (--skip-account).');
  } else {
    const claim = await obtainDeployerClaim(node, deployerAddress.toString());
    console.log('\nDeploying account on-chain (paying via bridged Fee Juice claim)...');
    console.log(`  Address: ${deployerAddress.toString()}`);
    try {
      const deployMethod = await deployerAccount.getDeployMethod();
      await deployMethod.send({
        from: NO_FROM,
        fee: {
          paymentMethod: new FeeJuicePaymentMethodWithClaim(deployerAddress, claim),
          gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) },
        },
        wait: { timeout: 600 },
      });
      markClaimConsumed(claimStorePath(), deployerAddress.toString());
      console.log('Account deployed; claim consumed.');
    } catch (err: any) {
      if (err?.cause?.message?.includes('Existing nullifier') || err?.message?.includes('Existing nullifier')) {
        console.log('Account already deployed, skipping (claim left intact for reuse).');
      } else {
        throw err;
      }
    }
  }

  await wallet.registerSender(deployerAddress, 'deployer');

  // Compute VK hashes for circuits (including dummy_move — required by
  // TripleTriadGame constructor since the abandoned-game flow was added).
  console.log('\nComputing VK hashes...');
  const api = await Barretenberg.new();
  const handArtifact = loadCircuitArtifact('prove_hand');
  const moveArtifact = loadCircuitArtifact('game_move');
  const dummyMoveArtifact = loadCircuitArtifact('dummy_move');

  const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
  const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);
  const dummyMoveBackend = new UltraHonkBackend(dummyMoveArtifact.bytecode, api);

  const [handVkBuf, moveVkBuf, dummyVkBuf] = await Promise.all([
    handBackend.getVerificationKey(),
    moveBackend.getVerificationKey(),
    dummyMoveBackend.getVerificationKey(),
  ]);
  const handVkHash = await computeVkHash(api, handVkBuf);
  const moveVkHash = await computeVkHash(api, moveVkBuf);
  const dummyVkHash = await computeVkHash(api, dummyVkBuf);
  console.log(`  hand VK hash:  ${handVkHash}`);
  console.log(`  move VK hash:  ${moveVkHash}`);
  console.log(`  dummy VK hash: ${dummyVkHash}`);

  // Load artifacts
  const nftArtifact = await loadContractArtifact('triple_triad_nft-TripleTriadNFT');
  const gameArtifact = await loadContractArtifact('triple_triad_game-TripleTriadGame');
  const tokenArtifact = await loadContractArtifact('arena_token-ArenaToken');

  // Helper for compressed string
  function encodeCompressedString(str: string): InstanceType<typeof Fr> {
    const buf = new Uint8Array(31);
    const encoded = new TextEncoder().encode(str);
    for (let i = 0; i < Math.min(encoded.length, 31); i++) buf[i] = encoded[i];
    let hex = '0x';
    for (let i = 0; i < 31; i++) hex += buf[i].toString(16).padStart(2, '0');
    return new Fr(BigInt(hex));
  }

  const { Contract } = await import('@aztec/aztec.js/contracts');

  // 1. Deploy NFT + Token in parallel (or resume from env vars if a prior
  //    deploy attempt left them on-chain). Set NFT_ADDRESS and TOKEN_ADDRESS
  //    env vars to skip — the script will `Contract.at(...)` them instead.
  let nftContract: any;
  let tokenContract: any;
  const nftEnvAddr = process.env.NFT_ADDRESS;
  const tokenEnvAddr = process.env.TOKEN_ADDRESS;

  if (nftEnvAddr && tokenEnvAddr) {
    console.log('\nReusing existing NFT + Token from env vars...');
    nftContract = await Contract.at(AztecAddress.fromStringUnsafe(nftEnvAddr), nftArtifact, wallet as never);
    tokenContract = await Contract.at(AztecAddress.fromStringUnsafe(tokenEnvAddr), tokenArtifact, wallet as never);
    console.log(`  NFT:   ${nftContract.address}`);
    console.log(`  Token: ${tokenContract.address}`);
  } else {
    // Serial per wallet: concurrent txs/proofs through one PXE cause IndexedDB
    // errors (binding ground rule). Deploy NFT, then Token.
    console.log('\nDeploying TripleTriadNFT...');
    const nftRes = await Contract.deploy(wallet, nftArtifact, [
      deployerAddress,
      encodeCompressedString('Axolotl Arena Cards'),
      encodeCompressedString('AXL'),
    ]).send(await sendAs(deployerAddress));
    nftContract = nftRes.contract;
    console.log(`  NFT:   ${nftContract.address}`);

    console.log('Deploying ArenaToken...');
    const tokenRes = await Contract.deploy(wallet, tokenArtifact, [
      deployerAddress,
    ]).send(await sendAs(deployerAddress));
    tokenContract = tokenRes.contract;
    console.log(`  Token: ${tokenContract.address}`);
  }

  // 2. Deploy Game (needs NFT + Token addresses + all three VK hashes).
  //    Or resume if GAME_ADDRESS is set.
  let gameContract: any;
  const gameEnvAddr = process.env.GAME_ADDRESS;
  if (gameEnvAddr) {
    console.log('Reusing existing Game from env var...');
    gameContract = await Contract.at(AztecAddress.fromStringUnsafe(gameEnvAddr), gameArtifact, wallet as never);
    console.log(`  Game:  ${gameContract.address}`);
  } else {
    console.log('Deploying TripleTriadGame...');
    const gameRes = await Contract.deploy(wallet, gameArtifact, [
      deployerAddress, // admin (for upgradeability)
      nftContract.address,
      Fr.fromHexString(handVkHash),
      Fr.fromHexString(moveVkHash),
      tokenContract.address,
      Fr.fromHexString(dummyVkHash),
      // permissive_vks: never. This script deploys to a real node, and the
      // constructor rejects dummy VKs registered as real ones unless this says
      // otherwise. There is no flag here on purpose.
      false,
    ]).send(await sendAs(deployerAddress));
    gameContract = gameRes.contract;
    console.log(`  Game:  ${gameContract.address}`);
  }

  // 3. Register senders (serial per wallet).
  await wallet.registerSender(nftContract.address, 'nft');
  await wallet.registerSender(tokenContract.address, 'token');
  await wallet.registerSender(gameContract.address, 'game');

  // 4. Wire contracts — serial per wallet (one tx/proof at a time).
  console.log('\nWiring contracts (serial)...');
  await nftContract.methods.set_game_contract(gameContract.address).send(await sendAs(deployerAddress));
  await nftContract.methods.set_token_contract(tokenContract.address).send(await sendAs(deployerAddress));
  await tokenContract.methods.set_nft_contract(nftContract.address).send(await sendAs(deployerAddress));
  await tokenContract.methods.set_game_contract(gameContract.address).send(await sendAs(deployerAddress));

  // Arena bot slots — the ONLY accounts allowed to hold duplicate cards
  // (TripleTriadNFT.mint_bot_cards). Each slot is write-once, so registering
  // here rather than later closes the window in which a freshly deployed NFT
  // has no bots and the exemption is unclaimed. Addresses are derived, not read
  // from a manifest, so the deploy never depends on provisioning having run.
  {
    const { arenaBotAccount } = await import('./lib/arenaBotAccount');
    const slots = Number(process.env.ARENA_BOT_SLOTS ?? '4');
    console.log(`Registering ${slots} arena bot slot(s)...`);
    for (let slot = 0; slot < slots; slot++) {
      const keys = arenaBotAccount(slot);
      const botAccount = await wallet.createSchnorrAccount(
        Fr.fromHexString(keys.secret),
        Fr.fromHexString(keys.salt),
        GrumpkinScalar.fromHexString(keys.signingKey),
      );
      await nftContract.methods
        .set_arena_bot(new Fr(BigInt(slot)), botAccount.address)
        .send(await sendAs(deployerAddress));
      console.log(`  slot ${slot}: ${botAccount.address.toString()}`);
    }
  }
  console.log('Done.');

  // Contracts are NOT updatable: a "code update" is a fresh redeploy (new
  // addresses, immediate), not the Aztec contract-class upgrade pattern (which
  // carries an enforced 24h delay on this rollup). See docs/plan/UPDATE_MODEL.md.

  // 5. Write .env
  //
  // The two files get DIFFERENT relay URLs, and that is the point. `.env` is the
  // local dev default and wants localhost. `.env.testnet` is the committed
  // config the Vercel production build reads, and wants the public relay.
  //
  // They used to get the same content, so every redeploy silently rewrote the
  // committed `wss://ws.aztec-arena.com` to `ws://localhost:5174`.
  //
  // That did NOT reach production, and the reason is worth keeping: Vercel's
  // Production env var wins over a committed dotenv at build time, and
  // sync-vercel-env.ts sets VITE_WS_URL from its own default rather than from
  // this file (plus a refuse-localhost guard). Two independent layers, neither
  // of which is this script's doing. What it did break is any build that does
  // not go through Vercel's env — a local `npm run build` for testnet, or the
  // day someone prunes that env var as redundant because the repo "already has
  // the right value". Then matchmaking opens a WebSocket to the player's own
  // machine and nothing else in the app looks wrong.
  const wsPort = process.env.WS_PORT || '5174';
  const addresses = `VITE_AZTEC_PXE_URL=${PXE_URL}
VITE_NFT_CONTRACT_ADDRESS=${nftContract.address.toString()}
VITE_GAME_CONTRACT_ADDRESS=${gameContract.address.toString()}
VITE_TOKEN_CONTRACT_ADDRESS=${tokenContract.address.toString()}
VITE_AZTEC_ENABLED=true
`;
  const PUBLIC_WS_URL = process.env.PUBLIC_WS_URL || 'wss://ws.aztec-arena.com';

  const targets: Array<[string, string]> = [
    ['packages/frontend/.env', `ws://localhost:${wsPort}`],
    ['packages/frontend/.env.testnet', PUBLIC_WS_URL],
  ];
  for (const [rel, wsUrl] of targets) {
    const p = resolve(ROOT_DIR, rel);
    writeFileSync(p, `# Auto-generated by deploy-testnet.ts\n${addresses}VITE_WS_URL=${wsUrl}\n`);
    console.log(`\nAddresses written to ${p} (relay ${wsUrl})`);
  }

  console.log('\n=== Deployment Complete ===');
  console.log(`NFT:   ${nftContract.address}`);
  console.log(`Game:  ${gameContract.address}`);
  console.log(`Token: ${tokenContract.address}`);
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
