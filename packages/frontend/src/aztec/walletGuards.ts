/**
 * Narrowing guards for Aztec context values required by async game
 * pipelines. Throwing (rather than returning null) surfaces missing
 * wallet state as a pipeline error instead of a silent no-op.
 */

export function requireWallet<W>(wallet: W | null | undefined): NonNullable<W> {
  if (!wallet) throw new Error('wallet is not connected');
  return wallet;
}

export function requireAccountAddress(accountAddress: string | null | undefined): string {
  if (!accountAddress) throw new Error('accountAddress is not set');
  return accountAddress;
}
