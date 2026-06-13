#!/usr/bin/env npx tsx
/**
 * Address-preserving update of the deployed triple_triad_game testnet contract
 * to a new (recompiled) contract class — the round-2 C2 fix (original-owner
 * replay check + 30-field board-state hash). The instance KEEPS its address;
 * the class change activates after the instance's update delay (>= 600s).
 *
 * Flow: register (publish) the new class -> admin-only update_to(new_class_id).
 * Only the game contract changed — NFT + token are untouched here.
 *
 * Env (source ~/.aztec-triad-private/deployer-testnet-key.txt; admin = deployer):
 *   AZTEC_PXE_URL  (default https://rpc.testnet.aztec-labs.com)
 *   DEPLOYER_SECRET / DEPLOYER_SALT / DEPLOYER_SIGNING_KEY
 *
 * Usage:
 *   npx tsx scripts/update-game-class-testnet.ts             # DRY RUN (validate + simulate, no sends)
 *   npx tsx scripts/update-game-class-testnet.ts --execute   # publish class + update_to
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

import { headroomMaxFeesPerGas } from './lib/feeSettings';

const PXE_URL = process.env.AZTEC_PXE_URL || 'https://rpc.testnet.aztec-labs.com';
// The live, address-preserving game instance to update (do NOT change).
const GAME_ADDR = '0x2d8675fc746e38ff6606cae2836c0cd0fa1693b12edb56396f83a530109b75f4';
const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');

async function main() {
  const EXECUTE = process.argv.includes('--execute');
  console.log(`=== Game class update (${EXECUTE ? 'EXECUTE' : 'DRY RUN'}) ===`);
  console.log(`PXE: ${PXE_URL}`);
  console.log(`Instance: ${GAME_ADDR}`);

  const { DEPLOYER_SECRET, DEPLOYER_SALT, DEPLOYER_SIGNING_KEY } = process.env;
  if (!DEPLOYER_SECRET || !DEPLOYER_SALT || !DEPLOYER_SIGNING_KEY) {
    throw new Error(
      'Missing deployer keys. Source them first:\n' +
        '  export $(grep -E "^DEPLOYER_" ~/.aztec-triad-private/deployer-testnet-key.txt | xargs)',
    );
  }

  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const { getContractClassFromArtifact } = await import('@aztec/stdlib/contract');

  // NEW (round-2) artifact -> the class we publish + update TO.
  const newArtifact = loadContractArtifact(JSON.parse(
    readFileSync(resolve(ROOT_DIR, 'packages/contracts/target/triple_triad_game-TripleTriadGame.json'), 'utf-8'),
  ));
  const { id: newClassId } = await getContractClassFromArtifact(newArtifact);
  console.log(`\nRound-2 game class id (publish/update TO): ${newClassId.toString()}`);

  // DEPLOYED (current) artifact -> needed to register/call the live instance,
  // because the PXE validates the artifact against the instance's CURRENT class
  // (still the pre-C2 class). update_to is identical across both classes.
  // Default: the committed artifact at the Option C deploy commit (321f73c),
  // class 0x236405f7... ; override with DEPLOYED_ARTIFACT.
  const deployedArtifactPath = process.env.DEPLOYED_ARTIFACT || '/tmp/ttg_deployed.json';
  const deployedArtifact = loadContractArtifact(JSON.parse(readFileSync(deployedArtifactPath, 'utf-8')));
  const { id: deployedClassId } = await getContractClassFromArtifact(deployedArtifact);
  console.log(`Deployed artifact (${deployedArtifactPath}) class: ${deployedClassId.toString()}`);

  const node = createAztecNodeClient(PXE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: true } });
  console.log('Waiting for PXE sync...');
  await new Promise(r => setTimeout(r, 8000));

  const deployer = await wallet.createSchnorrAccount(
    Fr.fromHexString(DEPLOYER_SECRET),
    Fr.fromHexString(DEPLOYER_SALT),
    GrumpkinScalar.fromHexString(DEPLOYER_SIGNING_KEY),
  );
  const deployerAddress = deployer.address;
  console.log(`Deployer (admin): ${deployerAddress.toString()}`);
  await wallet.registerSender(deployerAddress, 'deployer');

  const gameAddr = AztecAddress.fromString(GAME_ADDR);
  const before = await node.getContract(gameAddr);
  if (!before) throw new Error(`No contract instance found at ${GAME_ADDR} on ${PXE_URL}.`);
  console.log(`\nDeployed instance original class: ${before.originalContractClassId.toString()}`);
  console.log(`Deployed instance current  class: ${before.currentContractClassId.toString()}`);
  if (before.currentContractClassId.equals(newClassId)) {
    console.log('\nInstance is ALREADY on the round-2 class. Nothing to do.');
    return;
  }
  if (!before.currentContractClassId.equals(deployedClassId)) {
    throw new Error(
      `Deployed artifact class (${deployedClassId.toString()}) does not match the live instance's current ` +
        `class (${before.currentContractClassId.toString()}). Point DEPLOYED_ARTIFACT at the right artifact.`,
    );
  }

  // Register the instance with the DEPLOYED artifact (matches current class) so
  // the PXE can build/simulate the call against the live bytecode.
  await wallet.registerContract(before, deployedArtifact);
  const { Contract } = await import('@aztec/aztec.js/contracts');
  const game = await Contract.at(gameAddr, deployedArtifact, wallet as never);

  const sendAs = async (addr: any) => ({
    from: addr,
    fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
    wait: { timeout: 600 },
  });

  // send() resolves to the receipt when `wait` is in the opts (as sendAs sets);
  // tolerate both a receipt and a SentTx across versions.
  const sendAndConfirm = async (interaction: any): Promise<any> => {
    const sent = await interaction.send(await sendAs(deployerAddress));
    return typeof sent?.wait === 'function' ? await sent.wait() : sent;
  };

  const published = await node.getContractClass(newClassId).catch(() => undefined);
  console.log(`Round-2 class already published on-chain: ${!!published}`);

  if (!EXECUTE) {
    console.log('\n[dry-run] Simulating update_to to confirm the deployer is admin...');
    try {
      await game.methods.update_to(newClassId).simulate({ from: deployerAddress });
      console.log('[dry-run] update_to simulation fully OK (class already registered).');
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/New contract class is not registered/.test(msg)) {
        // Private admin assert PASSED; the only failure is the public update()
        // asserting the new class must be published first — which --execute does.
        console.log('[dry-run] Admin check PASSED. (Public step expects the class to be');
        console.log('          published first — handled in order by --execute.)');
      } else if (/Only admin can update/.test(msg)) {
        throw new Error(`Deployer is NOT the admin — update_to would be rejected. ${msg}`);
      } else {
        throw e;
      }
    }
    console.log('\nPlan on --execute:');
    console.log(`  1. ${published ? '(class already published — skip)' : 'publish round-2 class'}`);
    console.log('  2. update_to(new_class_id)  — address preserved');
    console.log('  3. activates after the instance update delay (>= 600s)');
    return;
  }

  // ---- EXECUTE ----
  if (!published) {
    console.log('\nPublishing round-2 class...');
    const { publishContractClass } = await import('@aztec/aztec.js/deployment');
    const interaction = await publishContractClass(wallet, newArtifact);
    const r = await sendAndConfirm(interaction);
    console.log(`Class published: tx ${r.txHash?.toString?.()} (block ${r.blockNumber}, status ${r.status}).`);
  }

  console.log('\nCalling update_to(new_class_id)...');
  const upd = await sendAndConfirm(game.methods.update_to(newClassId));
  console.log(`update_to mined: tx ${upd.txHash?.toString?.()} (block ${upd.blockNumber}, status ${upd.status}).`);

  // Verify: read the ContractInstanceUpdatedEvent for the authoritative
  // effective timestamp; fall back to (update block timestamp + delay) if the
  // log shape differs across versions. The on-chain action already succeeded —
  // never let verification reporting throw past this point.
  console.log('\n=== Verification ===');
  console.log(`Instance address (preserved): ${gameAddr.toString()}`);
  console.log(`New class id: ${newClassId.toString()}`);
  try {
    const { ContractInstanceUpdatedEvent } = await import('@aztec/protocol-contracts/instance-registry');
    const blockNum = upd.blockNumber!;
    const resp: any = await node.getPublicLogs({ txHash: upd.txHash } as any).catch(() => null)
      || await node.getPublicLogs({ fromBlock: blockNum, toBlock: blockNum + 1 } as any);
    const extLogs: any[] = resp?.logs ?? [];
    const evt = extLogs
      .map(el => el.log ?? el)
      .filter((l: any) => ContractInstanceUpdatedEvent.isContractInstanceUpdatedEvent(l))
      .map((l: any) => ContractInstanceUpdatedEvent.fromLog(l))
      .find((e: any) => e.address.equals(gameAddr));
    const blk: any = await node.getBlock(blockNum);
    const blkTs = Number(blk?.header?.globalVariables?.timestamp ?? 0n);
    if (evt) {
      const effSec = Number(evt.timestampOfChange);
      console.log(`prev class (event): ${evt.prevContractClassId.toString()}`);
      console.log(`new  class (event): ${evt.newContractClassId.toString()}`);
      console.log(`Effective at: unix ${effSec} = ${new Date(effSec * 1000).toISOString()}`);
      if (blkTs) console.log(`update_to block ts: unix ${blkTs} = ${new Date(blkTs * 1000).toISOString()}`);
      if (blkTs) console.log(`=> update delay = ${effSec - blkTs}s (requirement: >= 600)`);
    } else {
      console.log('ContractInstanceUpdatedEvent not located in logs; effective time ~= block ts + delay.');
      if (blkTs) console.log(`update_to block ts: unix ${blkTs}; effective ~= unix ${blkTs + 600} (delay 600s).`);
    }
    const after = await node.getContract(gameAddr);
    console.log(`current class right now (still original until delay elapses): ${after?.currentContractClassId.toString()}`);
  } catch (e: any) {
    console.log(`(verification read failed, but update_to DID succeed): ${e?.message || e}`);
  }
  console.log('\nDone. The class change is scheduled; address is unchanged.');
}

main().catch(e => {
  console.error('\nFAILED:', e?.message || e);
  process.exit(1);
});
