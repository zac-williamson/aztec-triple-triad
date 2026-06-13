/**
 * Testkit gate. The testkit only activates when the frontend is started with
 * VITE_TESTKIT=1 (the playtest harness does this). In production builds the
 * flag is statically false, so every testkit code path is dead-code-eliminated.
 */
export const TESTKIT_ENABLED = import.meta.env.VITE_TESTKIT === '1';
