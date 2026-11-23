/**
 * An account's Fee Juice balance, read from public state.
 *
 * Shared by the browser (a wallet the player connects brings its own account,
 * which may hold none) and the arena bot (BotChain.readFeeJuice).
 */
export async function readFeeJuiceBalance(
  node: { getPublicStorageAt(block: 'latest', contract: unknown, slot: unknown): Promise<{ toBigInt(): bigint }> },
  address: string,
): Promise<bigint> {
  const [{ Fr }, { ProtocolContractAddress }, { deriveStorageSlotInMap }, { AztecAddress }] = await Promise.all([
    import('@aztec-labs/foundation/curves/bn254'),
    import('@aztec-labs/aztec.js/protocol'),
    import('@aztec-labs/stdlib/hash'),
    import('@aztec-labs/aztec.js/addresses'),
  ]);
  // Slot 1 is FeeJuice's balances map — the derivation the SDK's own
  // getFeeJuiceBalance uses, rather than a slot read off a layout dump.
  const slot = await deriveStorageSlotInMap(new Fr(1), AztecAddress.fromStringUnsafe(address));
  const raw = await node.getPublicStorageAt('latest', ProtocolContractAddress.FeeJuice, slot);
  return raw.toBigInt();
}
