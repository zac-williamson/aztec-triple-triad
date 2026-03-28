/**
 * Deploy contracts for Azguard e2e tests.
 *
 * Uses EmbeddedWallet programmatically (not Azguard) to deploy
 * all 3 contracts + wire them together. Returns addresses and
 * writes a .env file for the frontend dev server.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';
import { loadContractArtifact, computeVkHash } from './e2e-helpers';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';

function findRootDir(): string {
  const candidates = [
    resolve(process.cwd(), '../..'),
    resolve(process.cwd()),
  ];
  for (const c of candidates) {
    try { readFileSync(resolve(c, 'package.json')); return c; } catch { continue; }
  }
  return resolve(process.cwd(), '../..');
}

export interface DeployedContracts {
  nftAddress: string;
  gameAddress: string;
  tokenAddress: string;
  pxeUrl: string;
}

export async function deployContractsForTest(): Promise<DeployedContracts> {
  const rootDir = findRootDir();
  console.log('[Deploy] Connecting to sandbox...');

  const node = createAztecNodeClient(PXE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  await new Promise(r => setTimeout(r, 5000));

  // Register SponsoredFPC
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  await wallet.registerContract(fpc, SponsoredFPCContractArtifact);
  const fee = new SponsoredFeePaymentMethod(fpc.address);
  const sendAs = (addr: any) => ({ from: addr, fee: { paymentMethod: fee }, wait: { timeout: 300 } });

  // Deploy account
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  await (await account.getDeployMethod()).send({
    from: AztecAddress.ZERO, fee: { paymentMethod: fee },
    skipClassPublication: true, skipInstancePublication: true, wait: { timeout: 300 },
  });
  await wallet.registerSender(account.address, 'deployer');
  console.log(`[Deploy] Deployer: ${account.address}`);

  // Compute VK hashes
  const api = await Barretenberg.new();
  const handArt = JSON.parse(readFileSync(resolve(rootDir, 'circuits/target/prove_hand.json'), 'utf-8'));
  const moveArt = JSON.parse(readFileSync(resolve(rootDir, 'circuits/target/game_move.json'), 'utf-8'));
  const handVk = await new UltraHonkBackend(handArt.bytecode, api).getVerificationKey();
  const moveVk = await new UltraHonkBackend(moveArt.bytecode, api).getVerificationKey();
  const handVkHash = await computeVkHash(api, handVk);
  const moveVkHash = await computeVkHash(api, moveVk);

  // Load artifacts
  const { loadContractArtifact: loadCA } = await import('@aztec/aztec.js/abi');
  function loadArtifact(name: string) {
    return loadCA(JSON.parse(readFileSync(resolve(rootDir, `packages/contracts/target/${name}.json`), 'utf-8')));
  }
  const nftArtifact = loadArtifact('triple_triad_nft-TripleTriadNFT');
  const gameArtifact = loadArtifact('triple_triad_game-TripleTriadGame');
  const tokenArtifact = loadArtifact('arena_token-ArenaToken');

  // Compressed string helper
  function encStr(str: string) {
    const buf = new Uint8Array(31);
    const enc = new TextEncoder().encode(str);
    for (let i = 0; i < Math.min(enc.length, 31); i++) buf[i] = enc[i];
    let hex = '0x';
    for (let i = 0; i < 31; i++) hex += buf[i].toString(16).padStart(2, '0');
    return new Fr(BigInt(hex));
  }

  // Deploy NFT
  console.log('[Deploy] Deploying NFT...');
  const { contract: nft } = await Contract.deploy(wallet, nftArtifact, [
    account.address, encStr('Axolotl Arena Cards'), encStr('AXL'),
  ]).send(sendAs(account.address));
  await wallet.registerSender(nft.address, 'nft');

  // Deploy Token
  console.log('[Deploy] Deploying Token...');
  const { contract: token } = await Contract.deploy(wallet, tokenArtifact, [
    account.address,
  ]).send(sendAs(account.address));
  await wallet.registerSender(token.address, 'token');

  // Deploy Game
  console.log('[Deploy] Deploying Game...');
  const { contract: game } = await Contract.deploy(wallet, gameArtifact, [
    nft.address, Fr.fromHexString(handVkHash), Fr.fromHexString(moveVkHash), token.address,
  ]).send(sendAs(account.address));
  await wallet.registerSender(game.address, 'game');

  // Wire contracts
  console.log('[Deploy] Wiring contracts...');
  await nft.methods.set_game_contract(game.address).send(sendAs(account.address));
  await nft.methods.set_token_contract(token.address).send(sendAs(account.address));
  await token.methods.set_nft_contract(nft.address).send(sendAs(account.address));
  await token.methods.set_game_contract(game.address).send(sendAs(account.address));

  const result: DeployedContracts = {
    nftAddress: nft.address.toString(),
    gameAddress: game.address.toString(),
    tokenAddress: token.address.toString(),
    pxeUrl: PXE_URL,
  };

  // Write .env for frontend
  const envContent = `# Auto-generated by deploy-for-test.ts
VITE_AZTEC_PXE_URL=${PXE_URL}
VITE_NFT_CONTRACT_ADDRESS=${result.nftAddress}
VITE_GAME_CONTRACT_ADDRESS=${result.gameAddress}
VITE_TOKEN_CONTRACT_ADDRESS=${result.tokenAddress}
VITE_WALLET_MODE=azguard
VITE_AZTEC_ENABLED=true
VITE_WS_URL=ws://localhost:5174
`;
  const envPath = resolve(rootDir, 'packages/frontend/.env');
  writeFileSync(envPath, envContent);
  console.log(`[Deploy] Addresses written to ${envPath}`);
  console.log(`[Deploy] NFT=${result.nftAddress} Game=${result.gameAddress} Token=${result.tokenAddress}`);

  return result;
}
