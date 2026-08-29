import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadProveHandCircuit, loadGameMoveCircuit, loadDummyMoveCircuit,
  setCircuitSource, resetCircuitSource, type CircuitArtifact,
} from '../circuitLoader';

const artifact = (name: string): CircuitArtifact => ({ bytecode: `bytecode:${name}`, abi: { name } });

afterEach(() => resetCircuitSource());

describe('circuitLoader', () => {
  it('routes each circuit to the installed source by name', async () => {
    const seen: string[] = [];
    setCircuitSource(async name => { seen.push(name); return artifact(name); });

    expect((await loadProveHandCircuit()).bytecode).toBe('bytecode:prove_hand');
    expect((await loadGameMoveCircuit()).bytecode).toBe('bytecode:game_move');
    expect((await loadDummyMoveCircuit()).bytecode).toBe('bytecode:dummy_move');
    expect(seen).toEqual(['prove_hand', 'game_move', 'dummy_move']);
  });

  it('caches — proving is hot, the artifact must be read once', async () => {
    let calls = 0;
    setCircuitSource(async name => { calls++; return artifact(name); });
    await loadProveHandCircuit();
    await loadProveHandCircuit();
    await loadProveHandCircuit();
    expect(calls).toBe(1);
  });

  it('drops the cache when the source changes, so stale artifacts cannot leak', async () => {
    setCircuitSource(async () => ({ bytecode: 'first', abi: {} }));
    expect((await loadProveHandCircuit()).bytecode).toBe('first');
    setCircuitSource(async () => ({ bytecode: 'second', abi: {} }));
    expect((await loadProveHandCircuit()).bytecode).toBe('second');
  });

  it('propagates a source failure rather than caching a broken artifact', async () => {
    let attempt = 0;
    setCircuitSource(async name => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return artifact(name);
    });
    await expect(loadProveHandCircuit()).rejects.toThrow('boom');
    // A failed load must not poison the cache.
    expect((await loadProveHandCircuit()).bytecode).toBe('bytecode:prove_hand');
  });

  it('defaults to fetching the public directory in a browser', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => artifact('prove_hand') });
    vi.stubGlobal('fetch', fetchMock);
    resetCircuitSource();
    await loadProveHandCircuit();
    expect(fetchMock).toHaveBeenCalledWith('/circuits/prove_hand.json');
    vi.unstubAllGlobals();
  });

  it('surfaces an HTTP failure with its status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }));
    resetCircuitSource();
    await expect(loadGameMoveCircuit()).rejects.toThrow(/game_move circuit: 404 Not Found/);
    vi.unstubAllGlobals();
  });
});
