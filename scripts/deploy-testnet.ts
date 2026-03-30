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
 *   1. Get Fee Juice from https://aztec-faucet.nethermind.io (select Testnet)
 *      or https://bridge.gregojuice.anothercoffeefor.me/
 *   2. Set env vars for your funded deployer account:
 *      export AZTEC_PXE_URL=https://rpc.testnet.aztec-labs.com
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
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'https://rpc.testnet.aztec-labs.com';
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

// ====================== Main ======================

async function main() {
  const createAccountOnly = process.argv.includes('--create-account');

  // Compile contracts first
  console.log('=== Compiling Contracts ===');
  const { execSync } = await import('child_process');
  execSync('aztec compile', {
    cwd: resolve(ROOT_DIR, 'packages/contracts'),
    stdio: 'inherit',
  });
  console.log('Compilation complete.\n');

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

  // Create or restore deployer account
  let secretFr: InstanceType<typeof Fr>;
  let saltFr: InstanceType<typeof Fr>;
  let signingKey: InstanceType<typeof GrumpkinScalar>;

  // Default keys from ../account_details_do_not_commit.md (override via env vars)
  const defaultSecret = '0x1666c6a09995cf41be384233f3d81355a99b421362806a83acdfd4a852aff30e';
  const defaultSalt = '0x2ab7f2d2a8ea4911b714136d35c37d1ba3fca2f22124b6650330b0eaeaa98f16';
  const defaultSigningKey = '0x12cba212b89ebfd4aa5169a31b64ce92355a4b1f19a4aeb0ac95171436258410';

  secretFr = Fr.fromHexString(process.env.DEPLOYER_SECRET || defaultSecret);
  saltFr = Fr.fromHexString(process.env.DEPLOYER_SALT || defaultSalt);
  signingKey = GrumpkinScalar.fromHexString(process.env.DEPLOYER_SIGNING_KEY || defaultSigningKey);

  const deployerAccount = await wallet.createSchnorrAccount(secretFr, saltFr, signingKey);
  const deployerAddress = deployerAccount.address;

  console.log(`\nDeployer address: ${deployerAddress.toString()}`);
  console.log(`Secret:          ${secretFr.toString()}`);
  console.log(`Salt:            ${saltFr.toString()}`);
  console.log(`Signing key:     ${signingKey.toString()}`);

  if (createAccountOnly) {
    console.log('\n=== Account Created ===');
    console.log('Fund this address with Fee Juice using one of:');
    console.log('  - https://aztec-faucet.nethermind.io (select Testnet)');
    console.log('  - https://bridge.gregojuice.anothercoffeefor.me/');
    console.log('\nThen re-run without --create-account to deploy contracts:');
    console.log(`  DEPLOYER_SECRET=${secretFr.toString()} DEPLOYER_SALT=${saltFr.toString()} DEPLOYER_SIGNING_KEY=${signingKey.toString()} npx tsx scripts/deploy-testnet.ts`);
    return;
  }

  // Testnet: no SponsoredFPC, use Fee Juice directly (default payment method)
  const sendAs = (addr: any) => ({
    from: addr,
    wait: { timeout: 600 },
  });

  // Deploy the deployer account (skip if already deployed)
  console.log('\nDeploying account on-chain...');
  try {
    const deployMethod = await deployerAccount.getDeployMethod();
    await deployMethod.send({
      from: AztecAddress.ZERO,
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: 600 },
    });
    console.log('Account deployed.');
  } catch (err: any) {
    if (err?.cause?.message?.includes('Existing nullifier') || err?.message?.includes('Existing nullifier')) {
      console.log('Account already deployed, skipping.');
    } else {
      throw err;
    }
  }

  await wallet.registerSender(deployerAddress, 'deployer');

  // Compute VK hashes for circuits
  console.log('\nComputing VK hashes...');
  const api = await Barretenberg.new();
  const handArtifact = loadCircuitArtifact('prove_hand');
  const moveArtifact = loadCircuitArtifact('game_move');

  const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
  const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);

  const [handVkBuf, moveVkBuf] = await Promise.all([
    handBackend.getVerificationKey(),
    moveBackend.getVerificationKey(),
  ]);
  const handVkHash = await computeVkHash(api, handVkBuf);
  const moveVkHash = await computeVkHash(api, moveVkBuf);
  console.log(`  hand VK hash: ${handVkHash}`);
  console.log(`  move VK hash: ${moveVkHash}`);

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

  // 1. Deploy NFT
  console.log('\nDeploying TripleTriadNFT...');
  const { contract: nftContract } = await Contract.deploy(wallet, nftArtifact, [
    deployerAddress,
    encodeCompressedString('Axolotl Arena Cards'),
    encodeCompressedString('AXL'),
  ]).send(sendAs(deployerAddress));
  console.log(`  NFT: ${nftContract.address}`);
  await wallet.registerSender(nftContract.address, 'nft');

  // 2. Deploy ArenaToken
  console.log('Deploying ArenaToken...');
  const { contract: tokenContract } = await Contract.deploy(wallet, tokenArtifact, [
    deployerAddress,
  ]).send(sendAs(deployerAddress));
  console.log(`  Token: ${tokenContract.address}`);
  await wallet.registerSender(tokenContract.address, 'token');

  // 3. Deploy Game
  console.log('Deploying TripleTriadGame...');
  const { contract: gameContract } = await Contract.deploy(wallet, gameArtifact, [
    nftContract.address,
    Fr.fromHexString(handVkHash),
    Fr.fromHexString(moveVkHash),
    tokenContract.address,
  ]).send(sendAs(deployerAddress));
  console.log(`  Game: ${gameContract.address}`);
  await wallet.registerSender(gameContract.address, 'game');

  // 4. Wire contracts
  console.log('\nWiring contracts...');
  await nftContract.methods.set_game_contract(gameContract.address).send(sendAs(deployerAddress));
  await nftContract.methods.set_token_contract(tokenContract.address).send(sendAs(deployerAddress));
  await tokenContract.methods.set_nft_contract(nftContract.address).send(sendAs(deployerAddress));
  await tokenContract.methods.set_game_contract(gameContract.address).send(sendAs(deployerAddress));
  console.log('Done.');

  // 5. Write .env
  const wsPort = process.env.WS_PORT || '5174';
  const envContent = `# Auto-generated by deploy-testnet.ts
VITE_AZTEC_PXE_URL=${PXE_URL}
VITE_NFT_CONTRACT_ADDRESS=${nftContract.address.toString()}
VITE_GAME_CONTRACT_ADDRESS=${gameContract.address.toString()}
VITE_TOKEN_CONTRACT_ADDRESS=${tokenContract.address.toString()}
VITE_AZTEC_ENABLED=true
VITE_WS_URL=ws://localhost:${wsPort}
`;

  const envPath = resolve(ROOT_DIR, 'packages/frontend/.env');
  writeFileSync(envPath, envContent);
  console.log(`\nAddresses written to ${envPath}`);

  console.log('\n=== Deployment Complete ===');
  console.log(`NFT:   ${nftContract.address}`);
  console.log(`Game:  ${gameContract.address}`);
  console.log(`Token: ${tokenContract.address}`);
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
