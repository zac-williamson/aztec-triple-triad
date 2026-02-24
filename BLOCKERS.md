# Blockers & Issues Log

## 2026-02-24 - Grumpkin curve operations not available in Noir stdlib (FIX-3)
**Status:** OPEN
**Severity:** MEDIUM
**Description:** FIX-3 requires ECDH key pair generation on the Grumpkin curve within the prove_hand circuit. Noir's standard library does not provide readily available Grumpkin curve scalar multiplication operations (G * scalar). This would be needed for encrypted card nullifier communication between players.
**Attempted solutions:** Reviewed Noir stdlib documentation. Grumpkin operations require custom implementation or a library.
**Resolution/Workaround:** Deferred to a later phase. The core security model (card_commit binding, capture validation) works without ECDH. Card nullifier encryption can be handled at the application layer using JavaScript crypto libraries, with the circuit only verifying the commitment.
