/**
 * Aztec network configuration.
 * All values can be overridden via environment variables.
 */
export const AZTEC_CONFIG = {
  /** PXE URL for connecting to an Aztec node */
  pxeUrl: import.meta.env.VITE_AZTEC_PXE_URL || 'https://v5.testnet.rpc.aztec-labs.com',

  /** Contract addresses (set after deployment) */
  nftContractAddress: import.meta.env.VITE_NFT_CONTRACT_ADDRESS || '',
  gameContractAddress: import.meta.env.VITE_GAME_CONTRACT_ADDRESS || '',
  tokenContractAddress: import.meta.env.VITE_TOKEN_CONTRACT_ADDRESS || '',

  /** localStorage keys for persistence, scoped by game contract address */
  storageKeys: {
    accountSecret: `aztec_tt_account_secret_${import.meta.env.VITE_GAME_CONTRACT_ADDRESS || 'default'}`,
    accountAddress: `aztec_tt_account_address_${import.meta.env.VITE_GAME_CONTRACT_ADDRESS || 'default'}`,
    accountSalt: `aztec_tt_account_salt_${import.meta.env.VITE_GAME_CONTRACT_ADDRESS || 'default'}`,
    signingKey: `aztec_tt_signing_key_${import.meta.env.VITE_GAME_CONTRACT_ADDRESS || 'default'}`,
    deploymentStatus: `aztec_tt_deployed_${import.meta.env.VITE_GAME_CONTRACT_ADDRESS || 'default'}`,
    cardsMintedPrefix: 'aztec_tt_cards_minted_',
  },

  /** Whether Aztec integration is enabled (can be disabled for WebSocket-only mode) */
  enabled: import.meta.env.VITE_AZTEC_ENABLED !== 'false',
} as const;
