/**
 * Testkit gate.
 *
 * Two ways in. `VITE_TESTKIT=1` at build time is how the playtest harness
 * builds it, and stays statically true so nothing changes for that path.
 *
 * The second is a runtime opt-in: `?e2e=1` in the URL. A deployed build with
 * no testkit cannot be driven at all — the board and the hand are both 3D, so
 * there is no element to click and no state to read — which meant the one
 * build real players use was the one build nothing could verify. Every
 * end-to-end result came from a dev build instead, and the differences between
 * them are exactly where the bugs were: a missing OPFS worker, and a create/join
 * handshake that stalled for sixteen minutes.
 *
 * It costs the testkit's code in the production bundle. It does not cost any
 * capability: the surface is the caller's OWN client state (the server already
 * withholds the opponent's hand), a screen-projection helper, and
 * claimAbandonedGame — which the UI offers as a button on the same screen.
 */
const runtimeOptIn = (): boolean => {
  try {
    return typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('e2e') === '1';
  } catch {
    return false;   // exotic embedding without a parseable location
  }
};

export const TESTKIT_ENABLED = import.meta.env.VITE_TESTKIT === '1' || runtimeOptIn();
