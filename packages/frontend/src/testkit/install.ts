/**
 * Testkit installer — imported once from main.tsx (the negotiated Lane 8
 * touchpoint). Attaches window.__triadTest when VITE_TESTKIT=1; in production
 * builds the static-false gate dead-code-eliminates the whole module graph.
 */
import { TESTKIT_ENABLED } from './enabled';

declare global {
  interface Window {
    __triadTest?: import('./api').TriadTestApi;
  }
}

if (TESTKIT_ENABLED) {
  import('./api').then(({ createApi }) => {
    window.__triadTest = createApi();
    console.log('[testkit] window.__triadTest installed');
  });
}
