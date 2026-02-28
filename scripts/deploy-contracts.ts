#!/usr/bin/env npx tsx
/**
 * Deploy Triple Triad contracts to the local Aztec sandbox.
 *
 * Usage:
 *   npx tsx scripts/deploy-contracts.ts
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: aztec compile packages/contracts
 *   - Circuits compiled: nargo compile --program-dir circuits
 *
 * Output:
 *   - Deployed contract addresses printed to console
 *   - Addresses written to packages/frontend/.env
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// Aztec SDK imports
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { deriveSigningKey } from '@aztec/stdlib/keys';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SPONSORED_FPC_SALT } from '@aztec/constants';

// bb.js for VK hash computation
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

// Import canonical card data and verification from game-logic package
import { CARD_DATABASE, verifyCardRankConsistency } from '../packages/game-logic/src/cards.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
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

/**
 * Compute the VK hash for a circuit.
 *
 * The bb_proof_verification module's verify_honk_proof checks that
 * hash(VK_fields) == key_hash. We must compute this hash identically.
 *
 * Steps:
 * 1. Get the VK bytes via getVerificationKey({ verifierTarget: 'noir-recursive' })
 * 2. Parse the VK bytes into 32-byte big-endian Field elements
 * 3. Hash the field elements using Poseidon2 (matching bb_proof_verification internals)
 *
 * The VK for UltraHonk recursive verification is serialized as N 32-byte
 * big-endian field elements (typically 115 fields = 3680 bytes).
 */
function bigintToBuffer32(n: bigint): Buffer {
  const hex = n.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function bufferToHex(buf: Buffer | Uint8Array | any): string {
  if (Buffer.isBuffer(buf)) return '0x' + buf.toString('hex').padStart(64, '0');
  if (buf instanceof Uint8Array) return '0x' + Buffer.from(buf).toString('hex').padStart(64, '0');
  if (typeof buf === 'bigint') return '0x' + buf.toString(16).padStart(64, '0');
  return '0x' + String(buf);
}

async function computeVkHash(
  api: Barretenberg,
  circuitBytecode: string,
): Promise<string> {
  const backend = new UltraHonkBackend(circuitBytecode, api);
  const vkBytes = await backend.getVerificationKey({ verifierTarget: 'noir-recursive' });

  // Parse VK bytes into 32-byte field elements (big-endian)
  const numFields = Math.floor(vkBytes.length / 32);
  const vkFields: string[] = [];

  for (let i = 0; i < numFields; i++) {
    const chunk = vkBytes.slice(i * 32, (i + 1) * 32);
    let hex = '0x';
    for (let j = 0; j < chunk.length; j++) {
      hex += chunk[j].toString(16).padStart(2, '0');
    }
    vkFields.push(hex);
  }

  if (typeof (api as any).poseidon2Hash !== 'function') {
    throw new Error('Barretenberg API does not expose poseidon2Hash');
  }

  const inputBuffers = vkFields.map((f) => bigintToBuffer32(BigInt(f)));
  const result = await (api as any).poseidon2Hash({ inputs: inputBuffers });
  return bufferToHex(result.hash);
}

// ====================== Main Deployment ======================

async function main() {
  console.log('=== Triple Triad Contract Deployment ===');
  console.log(`Connecting to Aztec node at ${PXE_URL}...`);

  // 0. Verify card rank consistency (Fix 5.2)
  console.log('Verifying card rank consistency...');
  const rankErrors = verifyCardRankConsistency();
  if (rankErrors.length > 0) {
    console.error('FATAL: Card rank consistency check failed:');
    for (const err of rankErrors) {
      console.error(`  - ${err}`);
    }
    console.error('Fix the card data before deploying. Ranks must match between game-logic and circuits.');
    process.exit(1);
  }
  console.log(`  All ${CARD_DATABASE.length} cards have valid, consistent ranks.`);

  // 1. Connect to the Aztec node
  const node = createAztecNodeClient(PXE_URL);

  // 2. Create an EmbeddedWallet with a deployer account
  console.log('Creating EmbeddedWallet...');
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

  // Wait for embedded PXE to sync so tx expiration timestamps are valid
  console.log('Waiting for PXE to sync...');
  await new Promise(r => setTimeout(r, 5000));

  // Register SponsoredFPC for fee payments
  console.log('Registering SponsoredFPC...');
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  const fee = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  // For contract deploys and method calls — publish class/instance on-chain
  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: 300 },
  });

  // For account deploys only — class already registered, skip publication
  const sendAsAccount = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: 300 },
    skipClassPublication: true,
    skipInstancePublication: true,
  });

  console.log('Creating deployer account...');
  const deployerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  // Deploy account with retry for PXE sync race
  const deployMethod = await deployerAccount.getDeployMethod();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await deployMethod.send(sendAsAccount(AztecAddress.ZERO));
      break;
    } catch (err: any) {
      if (err?.message?.includes('expiration timestamp') && attempt < 2) {
        console.log('  Deploy failed with expiration timestamp, retrying in 5s...');
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
  }
  const deployerAddress = deployerAccount.address;
  await wallet.registerSender(deployerAddress, 'deployer');
  console.log(`Deployer address: ${deployerAddress.toString()}`);

  // 3. Load contract artifacts
  console.log('Loading contract artifacts...');
  const nftArtifact = await loadContractArtifact('triple_triad_nft-TripleTriadNFT');
  const gameArtifact = await loadContractArtifact('triple_triad_game-TripleTriadGame');

  // 4. Compute VK hashes for circuits
  console.log('Computing VK hashes...');
  const api = await Barretenberg.new({ threads: 1 });

  const proveHandCircuit = loadCircuitArtifact('prove_hand');
  const gameMoveCircuit = loadCircuitArtifact('game_move');

  const handVkHash = await computeVkHash(api, proveHandCircuit.bytecode);
  const moveVkHash = await computeVkHash(api, gameMoveCircuit.bytecode);

  console.log(`  hand_vk_hash: ${handVkHash}`);
  console.log(`  move_vk_hash: ${moveVkHash}`);

  await api.destroy();

  // 5. Deploy NFT contract
  console.log('\nDeploying TripleTriadNFT...');
  // Constructor: (minter: AztecAddress, name: FieldCompressedString, symbol: FieldCompressedString)
  // Pack ASCII bytes into a field element (big-endian, up to 31 bytes)
  function encodeCompressedString(s: string): typeof Fr.prototype {
    let hex = '';
    for (let i = 0; i < s.length && i < 31; i++) {
      hex += s.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return new Fr(BigInt('0x' + hex));
  }
  const nameField = encodeCompressedString('Axolotl Arena Cards');
  const symbolField = encodeCompressedString('AXL');

  // Use the Aztec.js Contract deployment pattern
  const { Contract } = await import('@aztec/aztec.js/contracts');

  const nftContract = await Contract.deploy(wallet, nftArtifact, [
    deployerAddress,
    nameField,
    symbolField,
  ])
    .send(sendAs(deployerAddress));

  const nftAddress = nftContract.address;
  console.log(`TripleTriadNFT deployed at: ${nftAddress.toString()}`);

  // Register NFT contract as sender so PXE scans its private logs
  await wallet.registerSender(nftAddress, 'nft-contract');

  // 6. Deploy Game contract
  console.log('\nDeploying TripleTriadGame...');
  // Constructor: (nft_address: AztecAddress, hand_vk_hash: Field, move_vk_hash: Field)
  const gameContract = await Contract.deploy(wallet, gameArtifact, [
    nftAddress,
    Fr.fromHexString(handVkHash),
    Fr.fromHexString(moveVkHash),
  ])
    .send(sendAs(deployerAddress));

  const gameAddress = gameContract.address;
  console.log(`TripleTriadGame deployed at: ${gameAddress.toString()}`);

  // Register game contract as sender for note discovery
  await wallet.registerSender(gameAddress, 'game-contract');

  // 7. Register game contract on NFT contract
  console.log('\nRegistering game contract on NFT...');
  await nftContract.methods
    .set_game_contract(gameAddress)
    .send(sendAs(deployerAddress));
  console.log('Game contract registered on NFT.');

  // 8. Mint initial cards for testing
  console.log('\nMinting initial cards...');

  // Pack ranks: top + right*16 + bottom*256 + left*4096
  function packRanks(top: number, right: number, bottom: number, left: number): number {
    return top + right * 16 + bottom * 256 + left * 4096;
  }

  // Use canonical card data from game-logic package (CARD_DATABASE)
  // This ensures rank data matches across game-logic, circuits, and on-chain storage.
  const testCards = CARD_DATABASE.slice(0, 20); // First 20 cards for testing

  // Mint cards 1-10 to deployer (test player 1)
  for (const card of testCards.slice(0, 10)) {
    const packed = packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left);
    await nftContract.methods
      .mint_to_public(deployerAddress, new Fr(BigInt(card.id)), new Fr(BigInt(packed)))
      .send(sendAs(deployerAddress));
    console.log(`  Minted card #${card.id} ${card.name} (${card.ranks.top}/${card.ranks.right}/${card.ranks.bottom}/${card.ranks.left}) to deployer`);
  }

  // Create a second test account and mint cards 11-20 to it
  console.log('\nCreating player 2 account...');
  const player2Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  await (await player2Account.getDeployMethod()).send(sendAsAccount(AztecAddress.ZERO));
  const player2Address = player2Account.address;
  await wallet.registerSender(player2Address, 'player2');
  console.log(`Player 2 address: ${player2Address.toString()}`);

  for (const card of testCards.slice(10, 20)) {
    const packed = packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left);
    await nftContract.methods
      .mint_to_public(player2Address, new Fr(BigInt(card.id)), new Fr(BigInt(packed)))
      .send(sendAs(deployerAddress));
    console.log(`  Minted card #${card.id} ${card.name} (${card.ranks.top}/${card.ranks.right}/${card.ranks.bottom}/${card.ranks.left}) to player 2`);
  }

  // 9. Write deployed addresses to frontend .env
  const wsPort = process.env.WS_PORT || '5174';
  const envContent = `# Auto-generated by deploy-contracts.ts
VITE_AZTEC_PXE_URL=${PXE_URL}
VITE_NFT_CONTRACT_ADDRESS=${nftAddress.toString()}
VITE_GAME_CONTRACT_ADDRESS=${gameAddress.toString()}
VITE_AZTEC_ENABLED=true
VITE_WS_URL=ws://localhost:${wsPort}
`;

  const envPath = resolve(ROOT_DIR, 'packages/frontend/.env');
  writeFileSync(envPath, envContent);
  console.log(`\nAddresses written to ${envPath}`);

  // 10. Summary
  console.log('\n=== Deployment Complete ===');
  console.log(`NFT Contract:  ${nftAddress.toString()}`);
  console.log(`Game Contract: ${gameAddress.toString()}`);
  console.log(`Player 1:      ${deployerAddress.toString()}`);
  console.log(`Player 2:      ${player2Address.toString()}`);
  console.log(`\nCards 1-10 owned by Player 1 (public)`);
  console.log(`Cards 11-20 owned by Player 2 (public)`);
  console.log(`\nVK Hashes:`);
  console.log(`  hand: ${handVkHash}`);
  console.log(`  move: ${moveVkHash}`);
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
