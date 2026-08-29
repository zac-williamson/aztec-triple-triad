/**
 * Aztec network configuration.
 * All values can be overridden via environment variables.
 *
 * Reads Vite's `import.meta.env` when present and falls back to `process.env`.
 * The fallback exists because the arena bot runs this same chain code in Node
 * (docs/plan/BACKEND_OPPONENT.md phase 3), where `import.meta.env` is undefined
 * — touching `env('VITE_X')` there throws outright. Vite still exposes
 * every VITE_* var on `import.meta.env` at runtime, so the browser is unchanged;
 * the built bundle is asserted to still carry the addresses.
 */
const viteEnv: Record<string, string | undefined> =
  (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env) || {};

function env(key: string, fallback = ''): string {
  const fromVite = viteEnv[key];
  if (fromVite != null && fromVite !== '') return String(fromVite);
  const fromNode = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  if (fromNode != null && fromNode !== '') return String(fromNode);
  return fallback;
}
export const AZTEC_CONFIG = {
  /** PXE URL for connecting to an Aztec node */
  pxeUrl: env('VITE_AZTEC_PXE_URL', 'https://v5.testnet.rpc.aztec-labs.com'),

  /** Contract addresses (set after deployment) */
  nftContractAddress: env('VITE_NFT_CONTRACT_ADDRESS', ''),
  gameContractAddress: env('VITE_GAME_CONTRACT_ADDRESS', ''),
  tokenContractAddress: env('VITE_TOKEN_CONTRACT_ADDRESS', ''),

  /** localStorage keys for persistence, scoped by game contract address */
  storageKeys: {
    accountSecret: `aztec_tt_account_secret_${env('VITE_GAME_CONTRACT_ADDRESS', 'default')}`,
    accountAddress: `aztec_tt_account_address_${env('VITE_GAME_CONTRACT_ADDRESS', 'default')}`,
    accountSalt: `aztec_tt_account_salt_${env('VITE_GAME_CONTRACT_ADDRESS', 'default')}`,
    signingKey: `aztec_tt_signing_key_${env('VITE_GAME_CONTRACT_ADDRESS', 'default')}`,
    deploymentStatus: `aztec_tt_deployed_${env('VITE_GAME_CONTRACT_ADDRESS', 'default')}`,
    cardsMintedPrefix: 'aztec_tt_cards_minted_',
  },

  /** Whether Aztec integration is enabled (can be disabled for WebSocket-only mode) */
  enabled: env('VITE_AZTEC_ENABLED') !== 'false',
} as const;
