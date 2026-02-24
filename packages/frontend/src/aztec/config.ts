/**
 * Aztec network configuration.
 * All values can be overridden via environment variables.
 */
export const AZTEC_CONFIG = {
  /** PXE URL for connecting to an Aztec node */
  pxeUrl: import.meta.env.VITE_AZTEC_PXE_URL || 'http://localhost:8080',

  /** Contract addresses (set after deployment) */
  nftContractAddress: import.meta.env.VITE_NFT_CONTRACT_ADDRESS || '',
  gameContractAddress: import.meta.env.VITE_GAME_CONTRACT_ADDRESS || '',

  /** localStorage keys for persistence */
  storageKeys: {
    accountSecret: 'aztec_tt_account_secret',
    accountAddress: 'aztec_tt_account_address',
    accountSalt: 'aztec_tt_account_salt',
    deploymentStatus: 'aztec_tt_deployed',
  },

  /** Whether Aztec integration is enabled (can be disabled for WebSocket-only mode) */
  enabled: import.meta.env.VITE_AZTEC_ENABLED !== 'false',
} as const;
