#!/bin/bash
# Start the Aztec sandbox for local development.
# - Fresh data directory each time (no stale state)
# - minTxsPerBlock=0 so a mined block is allowed to be empty
# - AZTEC_NODE_DEBUG=true exposes the mineBlock debug RPC. v5's --local-network runs
#   an AUTOMINE sequencer that only builds an L2 block on tx activity (the 4.x timer
#   empty-block behaviour is gone), so a freshly-bridged Fee Juice L1→L2 message has
#   no block to land in. fundDevnet.ts pokes mineBlock after bridging to get the
#   message included. Without this the deployer/account claim fails
#   "No L1 to L2 message found".
rm -rf ~/.foundry/anvil/temp/*
export SEQ_MIN_TX_PER_BLOCK=0
export AZTEC_NODE_DEBUG=true
exec aztec start --local-network