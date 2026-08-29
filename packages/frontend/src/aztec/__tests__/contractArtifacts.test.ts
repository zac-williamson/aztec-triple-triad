import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  loadRawArtifact, setContractArtifactSource, resetContractArtifactSource, ARTIFACT_FILES,
} from '../contractArtifacts';

afterEach(() => resetContractArtifactSource());

describe('contractArtifacts', () => {
  it('maps each logical name to its compiled artifact filename', async () => {
    const seen: string[] = [];
    setContractArtifactSource(async file => { seen.push(file); return { file }; });
    await loadRawArtifact('game');
    await loadRawArtifact('nft');
    await loadRawArtifact('token');
    expect(seen).toEqual([ARTIFACT_FILES.game, ARTIFACT_FILES.nft, ARTIFACT_FILES.token]);
  });

  it('caches — contract artifacts are large and read on every game op', async () => {
    let calls = 0;
    setContractArtifactSource(async file => { calls++; return { file }; });
    await loadRawArtifact('game');
    await loadRawArtifact('game');
    expect(calls).toBe(1);
  });

  it('drops the cache when the source changes', async () => {
    setContractArtifactSource(async () => ({ tag: 'first' }));
    expect(await loadRawArtifact('game')).toEqual({ tag: 'first' });
    setContractArtifactSource(async () => ({ tag: 'second' }));
    expect(await loadRawArtifact('game')).toEqual({ tag: 'second' });
  });

  it('does not cache a failed load', async () => {
    let attempt = 0;
    setContractArtifactSource(async file => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return { file };
    });
    await expect(loadRawArtifact('nft')).rejects.toThrow('boom');
    expect(await loadRawArtifact('nft')).toEqual({ file: ARTIFACT_FILES.nft });
  });

  it('defaults to fetching the public directory', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: 1 }) });
    vi.stubGlobal('fetch', fetchMock);
    resetContractArtifactSource();
    await loadRawArtifact('game');
    expect(fetchMock).toHaveBeenCalledWith(`/contracts/${ARTIFACT_FILES.game}.json`);
    vi.unstubAllGlobals();
  });

  it('surfaces an HTTP failure with its status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }));
    resetContractArtifactSource();
    await expect(loadRawArtifact('nft')).rejects.toThrow(/404 Not Found/);
    vi.unstubAllGlobals();
  });
});
