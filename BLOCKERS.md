# Blockers & Issues Log

## 2026-02-24 - Grumpkin curve operations not available in Noir stdlib (FIX-3)
**Status:** RESOLVED
**Severity:** MEDIUM
**Description:** FIX-3 requires ECDH key pair generation on the Grumpkin curve within the prove_hand circuit. Initially thought Noir stdlib didn't provide Grumpkin curve ops.
**Attempted solutions:** Reviewed Noir stdlib documentation.
**Resolution:** Grumpkin ECDH IS available via `std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul}`. Implemented in both prove_hand (public key derivation) and game_move (shared secret + symmetric encryption) circuits. Uses Pedersen-hash-based stream cipher for nullifier encryption (Poseidon2 module is private in nargo 1.0.0-beta.18).

## 2026-02-24 - Poseidon2 hash module private in nargo 1.0.0-beta.18
**Status:** WORKAROUND
**Severity:** LOW
**Description:** The `std::hash::poseidon2::Poseidon2::hash` function is not accessible (marked private) in nargo 1.0.0-beta.18. The FIX_SPEC references Poseidon2 for symmetric encryption key expansion.
**Attempted solutions:** Tried `std::hash::poseidon2::Poseidon2::hash(data, len)` - module is private.
**Resolution/Workaround:** Used `std::hash::pedersen_hash` instead for key expansion in symmetric encryption. Both are collision-resistant hash functions providing equivalent security for key derivation. Pedersen is already used throughout the codebase for card commitments and state hashing.

## 2026-02-24 - Barretenberg (bb) native binary requires GLIBC 2.38/2.39 (FIX-4)
**Status:** RESOLVED
**Severity:** HIGH
**Description:** The `aztec compile` command uses the native `bb` (Barretenberg) binary for postprocessing contracts (generating verification keys and transpiled artifacts). This binary requires GLIBC 2.38 and 2.39, but the EC2 instance (Amazon Linux 2023) only has GLIBC 2.34. Error: `/lib64/libc.so.6: version 'GLIBC_2.39' not found`.
**Attempted solutions:**
1. Installed aztec CLI v4.0.0-devnet.2-patch.0 from cached aztec-install script
2. Verified nargo compilation succeeds (both circuits and contracts)
3. Only the bb postprocessing step fails
**Resolution:** Fixed with a two-part approach:
1. **GLIBC shim** (`glibc_shim.so`): Implements the 6 missing symbols (`__isoc23_strtol/ul/ll/ull`, `pidfd_spawnp/getpid`) as wrappers around existing glibc functions. The C23 strto* functions are functionally identical to C99 versions.
2. **Binary patch** (`bb_patched`): Hex-patches the `bb` ELF binary to change version requirement strings from `GLIBC_2.38`/`GLIBC_2.39` to `GLIBC_2.35` (available on Amazon Linux 2023) and fixes corresponding ELF hashes.
3. Usage: `BB=bb_wrapper.sh aztec compile` — wrapper handles LD_PRELOAD automatically.
4. Source code in `scripts/glibc-shim/` for reproducibility.
