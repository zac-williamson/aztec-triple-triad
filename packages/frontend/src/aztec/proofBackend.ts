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
      threads: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
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
