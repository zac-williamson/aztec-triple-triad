#!/usr/bin/env npx tsx
/**
 * Single-shot status of the address-preserving triple_triad_game class update.
 * The publish + update_to txs are already mined (blocks 114432 / 114433) and the
 * round-2 class is registered; the class flips on the instance after the inherent
 * protocol update delay. This does ONE query and reports whether it has flipped.
 *
 * Effective timestamp is taken from the ContractInstanceUpdatedEvent emitted by
 * the update_to tx (read at apply time). Run this again after the effective time
 * to confirm the flip — it does not block or poll.
 */
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { AztecAddress } from '@aztec/aztec.js/addresses';

const PXE_URL = process.env.AZTEC_PXE_URL || 'https://rpc.testnet.aztec-labs.com';
const GAME_ADDR = '0x2d8675fc746e38ff6606cae2836c0cd0fa1693b12edb56396f83a530109b75f4';
const OLD_CLASS_ID = '0x236405f73a97cc46d12399783b508719184a9fff108d8f10e8c553e047335e3f';
const NEW_CLASS_ID = '0x1e841b1e5554e2b647d3cf92b27354fff0ea947d49c7b7a63a9aff67cf13f690';
// From ContractInstanceUpdatedEvent.timestampOfChange (update_to tx 0x15fe07cf…,
// block 114433 ts 1781391588 + 86400s protocol delay).
const EFFECTIVE_TS = 1781477988;

async function main() {
  const node = createAztecNodeClient(PXE_URL);
  const gameAddr = AztecAddress.fromString(GAME_ADDR);

  const inst = await node.getContract(gameAddr); // ONE query
  const current = inst?.currentContractClassId?.toString();
  const flipped = current === NEW_CLASS_ID;
  const nowTs = Math.floor(Date.now() / 1000);

  console.log(`Instance:        ${GAME_ADDR} (address preserved)`);
  console.log(`Target class:    ${NEW_CLASS_ID} (round-2, original-owner C2 fix)`);
  console.log(`Current class:   ${current}`);
  console.log(`Effective at:    unix ${EFFECTIVE_TS} = ${new Date(EFFECTIVE_TS * 1000).toISOString()}`);
  if (flipped) {
    console.log(`\nFLIPPED ✓ — the instance now resolves to the round-2 class.`);
  } else if (current === OLD_CLASS_ID) {
    const remaining = EFFECTIVE_TS - nowTs;
    console.log(
      `\nNot flipped yet — still the old (pre-C2) class.` +
        (remaining > 0
          ? ` ~${Math.ceil(remaining / 60)} min (${(remaining / 3600).toFixed(1)} h) until effective; re-run after then.`
          : ` Effective time has passed but the node has not yet resolved the flip; re-run shortly.`),
    );
  } else {
    console.log(`\nUnexpected current class (neither old nor new). Investigate.`);
  }
}

main().catch(e => { console.error('verify failed:', e?.message || e); process.exit(1); });
