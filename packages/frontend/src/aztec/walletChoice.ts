/**
 * Which wallet the player chose: Nulo (the browser extension) or the wallet
 * this app keeps in the browser. Remembered so a returning player is not asked
 * again; "Switch wallet" in the menu forgets it.
 *
 * Not scoped by deployment, unlike the in-browser wallet's keys: the choice is
 * about the player, not about which contracts are live.
 */
export type WalletKind = 'embedded' | 'nulo';

export const WALLET_KIND_KEY = 'aztec_tt_wallet_kind';

export function loadWalletKind(): WalletKind | null {
  try {
    const v = localStorage.getItem(WALLET_KIND_KEY);
    return v === 'embedded' || v === 'nulo' ? v : null;
  } catch {
    return null;
  }
}

export function saveWalletKind(kind: WalletKind | null): void {
  try {
    if (kind) localStorage.setItem(WALLET_KIND_KEY, kind);
    else localStorage.removeItem(WALLET_KIND_KEY);
  } catch {
    /* storage blocked: the player is asked again next visit */
  }
}
