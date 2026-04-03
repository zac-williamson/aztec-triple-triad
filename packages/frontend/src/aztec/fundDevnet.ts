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

  // Wait for L1→L2 message to appear in the L2 tree.
  // With SEQ_MIN_TX_PER_BLOCK=0, the sequencer produces empty blocks
  // that incorporate pending L1→L2 messages.
  const messageHash = Fr.fromHexString(result.messageHash);
  log('Waiting for L1→L2 message to be included in L2...');
  for (let i = 0; i < 120; i++) {
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
