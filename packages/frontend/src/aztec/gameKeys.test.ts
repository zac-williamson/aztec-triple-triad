// @vitest-environment node
// Node's WebCrypto: jsdom's `crypto` has no `subtle`.
import { describe, expect, it } from 'vitest';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { deriveGameChannel, generateGameKeyPair, openPeerPayload, sealPeerPayload } from './gameKeys';

describe('the per-game key exchange', () => {
  it('gives both players the same game key, and a valid field element', async () => {
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const a = await deriveGameChannel(alice, bob.publicKey, 'room-1');
    const b = await deriveGameChannel(bob, alice.publicKey, 'room-1');
    expect(a.gameKey).toBe(b.gameKey);
    expect(BigInt(a.gameKey)).toBeLessThan(Fr.MODULUS);
  });

  it('opens on one side what the other sealed', async () => {
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const a = await deriveGameChannel(alice, bob.publicKey, 'room-1');
    const b = await deriveGameChannel(bob, alice.publicKey, 'room-1');
    const sealed = await sealPeerPayload(a.channelKey, 'room-1', { kind: 'RECORD', record: ['0x1', '0x2'] });
    expect(sealed.ciphertext).not.toContain('RECORD');
    await expect(openPeerPayload(b.channelKey, 'room-1', sealed)).resolves.toEqual({
      kind: 'RECORD',
      record: ['0x1', '0x2'],
    });
  });

  it('gives a different game key in a different room, even with the same keys', async () => {
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const one = await deriveGameChannel(alice, bob.publicKey, 'room-1');
    const two = await deriveGameChannel(alice, bob.publicKey, 'room-2');
    expect(one.gameKey).not.toBe(two.gameKey);
  });

  it('refuses a payload sealed for another room', async () => {
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const a = await deriveGameChannel(alice, bob.publicKey, 'room-1');
    const b = await deriveGameChannel(bob, alice.publicKey, 'room-1');
    const sealed = await sealPeerPayload(a.channelKey, 'room-1', { kind: 'SETTLED' });
    await expect(openPeerPayload(b.channelKey, 'room-2', sealed)).rejects.toThrow();
  });

  it('refuses a tampered payload', async () => {
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const a = await deriveGameChannel(alice, bob.publicKey, 'room-1');
    const b = await deriveGameChannel(bob, alice.publicKey, 'room-1');
    const sealed = await sealPeerPayload(a.channelKey, 'room-1', { kind: 'SETTLED', txHash: '0xabc' });
    const bytes = atob(sealed.ciphertext).split('');
    bytes[3] = String.fromCharCode(bytes[3].charCodeAt(0) ^ 1);
    await expect(openPeerPayload(b.channelKey, 'room-1', { ...sealed, ciphertext: btoa(bytes.join('')) })).rejects.toThrow();
  });

  it('a relay that swaps in its own key ends up on a different game key', async () => {
    // A man in the middle completes one exchange with each player; the two
    // players then disagree, which the on-chain join refuses (the joiner's
    // game id would not exist).
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const relay = await generateGameKeyPair();
    const aliceSide = await deriveGameChannel(alice, relay.publicKey, 'room-1');
    const bobSide = await deriveGameChannel(bob, relay.publicKey, 'room-1');
    expect(aliceSide.gameKey).not.toBe(bobSide.gameKey);
  });

  it('survives a reload: the stored private key derives the same channel', async () => {
    const alice = await generateGameKeyPair();
    const bob = await generateGameKeyPair();
    const before = await deriveGameChannel(alice, bob.publicKey, 'room-1');
    const restored = JSON.parse(JSON.stringify(alice));
    const after = await deriveGameChannel(restored, bob.publicKey, 'room-1');
    expect(after.gameKey).toBe(before.gameKey);
  });
});
