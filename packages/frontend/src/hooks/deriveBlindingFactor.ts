/**
 * Derive the blinding factor from the NFT contract.
 *
 * Calls compute_blinding_factor().simulate({ from: playerAddr }) on the NFT contract,
 * which computes poseidon2([nhk_app, nft_contract_address]) — the same derivation
 * used by commit_five_nfts on-chain. This ensures card commits match.
 *
 * Results are cached in localStorage so they persist across page reloads.
 */
export async function deriveBlindingFactor(
  wallet: unknown,
  accountAddress: string,
  gameId: string,
  playerNumber: number,
): Promise<string> {
  const cacheKey = `tt_blinding_${accountAddress}_${gameId}_${playerNumber}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;

  const { AZTEC_CONFIG } = await import('../aztec/config');
  if (!AZTEC_CONFIG.nftContractAddress) {
    throw new Error('NFT contract address not configured');
  }

  const [{ AztecAddress }, { Contract }, { loadContractArtifact }] = await Promise.all([
    import('@aztec/aztec.js/addresses'),
    import('@aztec/aztec.js/contracts'),
    import('@aztec/aztec.js/abi'),
  ]);

  const nftAddress = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
  const playerAddr = AztecAddress.fromString(accountAddress);

  // Load and transform the NFT contract artifact
  const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
  if (!resp.ok) throw new Error('Failed to load NFT contract artifact');
  const rawArtifact = await resp.json();
  const artifact = loadContractArtifact(rawArtifact);

  const nftContract = await Contract.at(nftAddress, artifact, wallet as never);

  const blinding = await nftContract.methods
    .compute_blinding_factor()
    .simulate({ from: playerAddr });

  // Normalize to hex string
  const hex = typeof blinding === 'bigint'
    ? '0x' + blinding.toString(16)
    : String(blinding);

  localStorage.setItem(cacheKey, hex);
  return hex;
}
