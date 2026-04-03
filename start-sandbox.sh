#!/bin/bash
# Start the Aztec sandbox for local development.
# - Fresh data directory each time (no stale state)
# - minTxsPerBlock=0 so the sequencer produces empty blocks
#   (needed for L1→L2 Fee Juice messages to be processed)
export SEQ_MIN_TX_PER_BLOCK=0
exec aztec start --local-network \
  --data-directory "$(mktemp -d)"
