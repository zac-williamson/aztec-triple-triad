/**
 * The blinding factor must be read through an identity-stable GETTER.
 *
 * Everything in SettlementSessionDeps is stable so it can sit in useCallback
 * dependency arrays. Passing the blinding factor as a plain VALUE looked
 * equivalent and was not: the settlement callbacks capture the deps object at
 * the render where the value was still null — the pipeline sets it later — and
 * the settlement then failed with "No blinding factor for this game" against a
 * session that demonstrably had one.
 *
 * Every unit test passed with the broken version, because they build the stub
 * with the value already populated. Only a real game caught it, so this test
 * reproduces the ordering that matters: read AFTER the value arrives, through a
 * getter captured BEFORE it did.
 */
import { describe, it, expect } from 'vitest';

/** The shape settlement consumes, reduced to the part under test. */
interface Deps { getBlindingFactor: () => string | null }

/** Stands in for a settlement callback: captures deps once, runs much later. */
function captureThenRead(deps: Deps): () => string | null {
  const captured = deps;
  return () => captured.getBlindingFactor();
}

describe('blinding factor is read late, not captured early', () => {
  it('sees a value that arrives after the callback was created', () => {
    let blinding: string | null = null;              // pipeline has not run yet
    const read = captureThenRead({ getBlindingFactor: () => blinding });

    blinding = '0xbeef';                              // create/join completes

    expect(read()).toBe('0xbeef');
  });

  it('a plain value captured at the same moment reads null forever', () => {
    const blinding: string | null = null;
    const deps = { blindingFactor: blinding };        // the shape that broke
    const captured = deps;
    // Later assignment cannot reach the captured object — which is exactly the
    // failure a real game produced and every unit test missed.
    expect(captured.blindingFactor).toBeNull();
  });
});
