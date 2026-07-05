/**
 * Barretenberg singleton manager.
 *
 * Manages a single Barretenberg WASM instance for the lifetime of the app.
 * Reusing the instance avoids expensive re-initialization per proof.
 */
import { Barretenberg } from '@aztec/bb.js';

let bbInstance: Barretenberg | null = null;
let bbInitPromise: Promise<Barretenberg> | null = null;

/**
 * Prover thread count: navigator.hardwareConcurrency, overridable via the
 * `triad_proof_threads` localStorage key. The playtest harness sets the
 * override to half the cores — two headless browsers proving on one machine
 * otherwise starve each other's timers and background sync.
 */
function proverThreads(): number {
  const fallback = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  try {
    const override = Number(localStorage.getItem('triad_proof_threads'));
    if (Number.isInteger(override) && override > 0) return override;
  } catch { /* no localStorage (worker/SSR) — use the hardware count */ }
  return fallback;
}

/**
 * Get (or lazily create) the shared Barretenberg instance.
 * Uses navigator.hardwareConcurrency for thread count when available.
 */
export async function getBarretenberg(): Promise<Barretenberg> {
  if (bbInstance) {
    return bbInstance;
  }
  // Prevent multiple concurrent initializations
  if (!bbInitPromise) {
    bbInitPromise = Barretenberg.new({
      threads: proverThreads(),
    }).then((api) => {
      bbInstance = api;
      bbInitPromise = null;
      return api;
    }).catch((err) => {
      bbInitPromise = null;
      throw err;
    });
  }
  return bbInitPromise;
}

/**
 * Destroy the shared Barretenberg instance and free WASM memory.
 * Call this when leaving the game page.
 */
export async function destroyBarretenberg(): Promise<void> {
  if (bbInstance) {
    await bbInstance.destroy();
    bbInstance = null;
  }
}
