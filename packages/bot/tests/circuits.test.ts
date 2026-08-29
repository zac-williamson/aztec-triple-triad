import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { fileCircuitSource, DEFAULT_CIRCUITS_DIR } from '../src/circuits.js';

describe('fileCircuitSource', () => {
  it('reads a compiled artifact from disk', async () => {
    const src = fileCircuitSource();
    if (!existsSync(`${DEFAULT_CIRCUITS_DIR}/prove_hand.json`)) {
      throw new Error(`circuits not compiled at ${DEFAULT_CIRCUITS_DIR} — run: cd circuits && nargo compile`);
    }
    const artifact = await src('prove_hand');
    expect(typeof artifact.bytecode).toBe('string');
    expect(artifact.bytecode.length).toBeGreaterThan(0);
    expect(artifact.abi).toBeTruthy();
  });

  it('fails loudly with the fix, not with a cryptic ENOENT', async () => {
    const src = fileCircuitSource('/nonexistent/circuits');
    await expect(src('prove_hand')).rejects.toThrow(/Circuit artifact not found.*nargo compile/s);
  });
});

describe('fileContractArtifactSource', () => {
  it('reads a compiled contract artifact from disk', async () => {
    const { fileContractArtifactSource, DEFAULT_CONTRACTS_DIR } = await import('../src/circuits.js');
    const src = fileContractArtifactSource();
    if (!existsSync(`${DEFAULT_CONTRACTS_DIR}/triple_triad_nft-TripleTriadNFT.json`)) {
      throw new Error(`contracts not compiled at ${DEFAULT_CONTRACTS_DIR} — run: cd packages/contracts && aztec compile`);
    }
    const artifact = await src('triple_triad_nft-TripleTriadNFT') as any;
    expect(artifact).toBeTruthy();
    expect(artifact.name ?? artifact.functions).toBeTruthy();
  });

  it('names the fix when the artifact is missing', async () => {
    const { fileContractArtifactSource } = await import('../src/circuits.js');
    const src = fileContractArtifactSource('/nonexistent/contracts');
    await expect(src('triple_triad_nft-TripleTriadNFT')).rejects.toThrow(/Contract artifact not found.*aztec compile/s);
  });
});
