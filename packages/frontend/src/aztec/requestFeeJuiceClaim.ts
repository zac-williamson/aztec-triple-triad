/**
 * Fee Juice faucet abstraction (item I, Option B).
 *
 * A brand-new testnet user holds no L1 (Sepolia) ETH, so they cannot bridge
 * Fee Juice themselves. The project backend faucet does it for them: it bridges
 * from a server-held treasury and returns a consumable claim that the new
 * account redeems during its deploy tx (`FeeJuicePaymentMethodWithClaim`).
 *
 * The treasury key NEVER reaches the browser — this module only POSTs an L2
 * address and receives a claim. SponsoredFPC is BANNED; this bridges real Fee
 * Juice. The deploy/mint that consumes the claim is the proven devnet path
 * (`connectToAztec.deployAndRegister({ feeJuiceClaim })`).
 */
import type { FeeJuiceClaim } from './fundDevnet';

/**
 * Success body the backend faucet returns from `POST {faucetUrl}/faucet`:
 * `{ claim: {...}, reused }` (backend server.ts wraps the serialized claim under
 * `claim`). We unwrap `claim` and read only the three fields the deploy-time
 * claim consumes, ignoring the rest (claimSecretHash / messageHash / status /
 * bridgedAt) and the `reused` flag.
 */
interface FaucetClaimResponse {
  claimAmount: string;
  claimSecret: string;
  messageLeafIndex: string | number;
}

interface FaucetResponseBody {
  claim?: Partial<FaucetClaimResponse>;
  reused?: boolean;
}

function hasClaimFields(d: Partial<FaucetClaimResponse>): d is FaucetClaimResponse {
  return d.claimAmount != null && d.claimSecret != null && d.messageLeafIndex != null;
}

/**
 * Request a consumable Fee Juice claim for `l2Address` from the backend faucet.
 *
 * The faucet bridges from L1 and waits for the L1→L2 message to be included
 * before responding, so the returned claim is immediately consumable in the
 * account's deploy tx (the request may therefore take up to ~a minute — no
 * client timeout is imposed). Throws on any non-OK response or an incomplete
 * claim; the caller is expected to fall back to manual funding on throw.
 */
export async function requestFeeJuiceClaim(
  faucetUrl: string,
  l2Address: string,
): Promise<FeeJuiceClaim> {
  const base = faucetUrl.replace(/\/+$/, '');
  const resp = await fetch(`${base}/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ l2Address }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Faucet request failed (${resp.status}): ${detail || resp.statusText}`);
  }

  // Canonical contract: the claim is WRAPPED under `claim`. A top-level read
  // (the prior bug) finds nothing and silently fails onboarding with the
  // misleading "incomplete claim", which is why in-app testnet funding never
  // worked. No flat-shape fallback — wrapped is the contract.
  const body = (await resp.json().catch(() => ({}))) as FaucetResponseBody;
  const data = body.claim ?? {};
  if (!hasClaimFields(data)) {
    throw new Error('Faucet returned an incomplete claim');
  }

  const { Fr } = await import('@aztec/aztec.js/fields');
  const secret = String(data.claimSecret);
  return {
    claimAmount: BigInt(data.claimAmount),
    claimSecret: Fr.fromHexString(secret.startsWith('0x') ? secret : '0x' + secret),
    messageLeafIndex: BigInt(data.messageLeafIndex),
  };
}
