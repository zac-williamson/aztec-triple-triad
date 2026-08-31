/**
 * Diagnostics worth having AFTER something has already gone wrong.
 *
 * The PXE queue lines exist to answer one question — is this operation waiting
 * or is it hung — and they answered it: a join sat behind an abandonment sweep
 * for sixteen minutes and every log was silent about why. But they printed
 * into every player's console, which is noise for everyone who is not
 * debugging, and noise is how a real message hides.
 *
 * A flag on its own does not solve this. Whoever hits the problem has the flag
 * off, and turning it on means asking them to reproduce a bug that took an
 * hour to hit once. So every line is RECORDED, always, and only PRINTED when
 * somebody asked for it. Support can ask a player to run `__triadDiagnostics()`
 * in their console and paste the result.
 */

/** Roughly an hour of queue activity; small enough to paste into a chat. */
const MAX_LINES = 200;
const ring: string[] = [];

/**
 * Reached through `globalThis`, not `window`, because the BOT compiles these
 * frontend sources with a Node lib that has no DOM — a build that only fails
 * on the deployment box, where it is most expensive to discover.
 */
const host = globalThis as unknown as {
  localStorage?: { getItem(key: string): string | null };
  location?: { search?: string };
  __triadDiagnostics?: () => string;
};

function printingEnabled(): boolean {
  try {
    if (host.localStorage?.getItem('triad_debug') === '1') return true;
    return new URLSearchParams(host.location?.search ?? '').get('e2e') === '1';
  } catch {
    // Private mode, a sandboxed frame, storage disabled — recording still works.
    return false;
  }
}

/** Record a diagnostic line, and print it only if diagnostics are switched on. */
export function diag(line: string): void {
  ring.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  if (ring.length > MAX_LINES) ring.shift();
  if (printingEnabled()) console.log(line);
}

/** Everything recorded this session, oldest first. */
export function diagnosticsDump(): string {
  return ring.join('\n');
}

/** For tests; the ring is module state and would otherwise leak between them. */
export function resetDiagnostics(): void {
  ring.length = 0;
}

// Reachable from a player's console without shipping them a debug build.
try {
  host.__triadDiagnostics = diagnosticsDump;
} catch { /* a frozen or exotic global: recording still works */ }
