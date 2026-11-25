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

/** Anvil's default port, where `aztec start --local-network` puts its L1. */
export const DEFAULT_DEVNET_L1_RPC = 'http://localhost:8545';
/** The local network's default node port, where the block nudge goes. */
export const DEFAULT_DEVNET_NODE_RPC = 'http://localhost:8080';

export async function fundAccountOnDevnet(
  node: any,
  accountAddress: string,
  log: LogFn,
  // A second local network (ANVIL_PORT=…, --port …) has its L1 and its node
  // elsewhere. Bridging against the wrong anvil, or nudging the wrong node,
  // works on someone else's chain while this one never mines the message.
  l1RpcUrl: string = DEFAULT_DEVNET_L1_RPC,
  nodeRpcUrl: string = DEFAULT_DEVNET_NODE_RPC,
): Promise<FeeJuiceClaim> {
  const [{ L1FeeJuicePortalManager }, { AztecAddress }, { createExtendedL1Client }, { Fr }] = await Promise.all([
    import('@aztec-labs/aztec.js/ethereum'),
    import('@aztec-labs/aztec.js/addresses'),
    import('@aztec-labs/ethereum/client'),
    import('@aztec-labs/aztec.js/fields'),
  ]);

  const l2Address = AztecAddress.fromStringUnsafe(accountAddress);

  const l1Client = createExtendedL1Client(
    [l1RpcUrl],
    ANVIL_MNEMONIC,
  );

  // Same shape as scripts/lib/feeJuiceBridge.ts: derive from a real logger so a
  // level method the SDK adds later (5.2 added logger.trace() inside
  // L1TxUtils.estimateGas) cannot crash the bridge.
  const { createLogger } = await import('@aztec-labs/foundation/log');
  const baseLogger: any = createLogger('frontend:fundDevnet');
  const bridgeLogger: any = {};
  for (const key in baseLogger) {
    const value = baseLogger[key];
    bridgeLogger[key] = typeof value === 'function' ? value.bind(baseLogger) : value;
  }
  const noop = () => {};
  Object.assign(bridgeLogger, {
    info: log,
    warn: log,
    error: log,
    debug: noop,
    verbose: noop,
    trace: noop,
  });

  const portalManager = await L1FeeJuicePortalManager.new(node, l1Client, bridgeLogger);

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
      await fetch(nodeRpcUrl, {
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
