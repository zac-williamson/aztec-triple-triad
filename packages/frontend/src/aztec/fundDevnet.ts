/**
 * Auto-fund an Aztec account with Fee Juice on a local devnet.
 *
 * Bridges Fee Juice from L1 (via the FeeAssetHandler faucet on Anvil)
 * and waits for the L1→L2 message to be included in the L2 tree.
 *
 * Requires the sandbox to be started with SEQ_MIN_TX_PER_BLOCK=0
 * (see start-sandbox.sh) so empty blocks are produced and L1→L2
 * messages get processed without pending L2 transactions.
 */

/** Anvil's default test mnemonic */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

type LogFn = (msg: string) => void;

export interface FeeJuiceClaim {
  claimAmount: bigint;
  claimSecret: any;       // Fr
  messageLeafIndex: bigint;
}

export async function fundAccountOnDevnet(
  node: any,
  accountAddress: string,
  log: LogFn,
): Promise<FeeJuiceClaim> {
  const [{ L1FeeJuicePortalManager }, { AztecAddress }, { createExtendedL1Client }, { Fr }] = await Promise.all([
    import('@aztec/aztec.js/ethereum'),
    import('@aztec/aztec.js/addresses'),
    import('@aztec/ethereum/client'),
    import('@aztec/aztec.js/fields'),
  ]);

  const l2Address = AztecAddress.fromString(accountAddress);

  const l1Client = createExtendedL1Client(
    ['http://localhost:8545'],
    ANVIL_MNEMONIC,
  );

  const portalManager = await L1FeeJuicePortalManager.new(
    node,
    l1Client,
    { info: log, warn: log, error: log, debug: () => {}, verbose: () => {} } as any,
  );

  log(`Bridging Fee Juice to ${accountAddress.slice(0, 18)}...`);
  const result = await portalManager.bridgeTokensPublic(l2Address, undefined, true);
  log('Fee Juice bridged to L1 portal');

  // Wait for the L1→L2 message to appear in the L2 tree.
  // v5: `aztec start --local-network` runs an AUTOMINE sequencer
  // (USE_AUTOMINE_SEQUENCER) that only builds an L2 block on tx activity — so a
  // freshly-bridged L1→L2 message has no block to land in (the 4.x timer-based
  // empty-block behaviour from minTxsPerBlock=0 is gone). Nudge the sequencer to
  // mine an empty block each poll via the debug endpoint (exposed by
  // AZTEC_NODE_DEBUG=true in start-sandbox.sh); ~2 blocks after the deposit the
  // message is included. minTxsPerBlock=0 is still required so the nudged block
  // can be empty. No-op/ignored if the debug endpoint is absent.
  const mineBlock = async () => {
    try {
      await fetch('http://localhost:8080', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'aztecDebug_mineBlock', params: [], id: 1 }),
      });
    } catch { /* slot may already hold a block; ignore and retry next poll */ }
  };
  const messageHash = Fr.fromHexString(result.messageHash);
  log('Waiting for L1→L2 message to be included in L2...');
  for (let i = 0; i < 120; i++) {
    await mineBlock();
    try {
      const witness = await node.getL1ToL2MessageMembershipWitness('latest', messageHash);
      if (witness) {
        log('L1→L2 message confirmed in tree');
        break;
      }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }

  return {
    claimAmount: result.claimAmount,
    claimSecret: result.claimSecret,
    messageLeafIndex: result.messageLeafIndex,
  };
}
