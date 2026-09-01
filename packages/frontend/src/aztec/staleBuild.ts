/**
 * Notice when this tab is running a build that no longer exists.
 *
 * The app loads most of its weight lazily — 53 dynamic imports, including the
 * proving code. Each is a fetch of a content-hashed file, and a deploy replaces
 * those files: a tab opened before the deploy asks for a chunk that is no
 * longer served and gets "Failed to fetch dynamically imported module".
 *
 * In most apps that is a cosmetic annoyance. Here it lands mid-game, on the
 * hand or move proof, and a proof that never generates is a game that cannot be
 * settled — with five cards committed on-chain behind it. Seen in production
 * the first time a deploy happened while a game was in flight.
 *
 * Reloading fixes it (the game is restored from storage), but reloading a tab
 * with a transaction in flight is its own hazard, so this reports rather than
 * acts and lets the player choose.
 */

type Listener = (stale: boolean) => void;

const listeners = new Set<Listener>();
let stale = false;

/** True once this tab has failed to load a chunk that no longer exists. */
export function isBuildStale(): boolean {
  return stale;
}

export function onBuildStale(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function markStale(reason: string): void {
  if (stale) return;
  stale = true;
  console.error(`[staleBuild] this tab is running a build that is no longer deployed: ${reason}`);
  for (const cb of listeners) { try { cb(true); } catch { /* a bad listener must not hide this */ } }
}

/** The shape of a chunk that has been deployed out from under us. */
export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i
    .test(msg);
}

/** Call once at startup. */
export function watchForStaleBuild(): void {
  // Vite's own signal, raised when a lazy chunk cannot be preloaded.
  window.addEventListener('vite:preloadError', e => {
    markStale((e as unknown as { payload?: Error }).payload?.message ?? 'vite:preloadError');
  });
  // And the plain rejection, for imports that fail outside the preload path.
  window.addEventListener('unhandledrejection', e => {
    if (isStaleChunkError(e.reason)) markStale(String(e.reason?.message ?? e.reason));
  });
}
