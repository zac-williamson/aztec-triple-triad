// @vitest-environment node
// Node's WebCrypto: jsdom's `crypto` has no `subtle`.
/**
 * The players' sealed channel: payloads from the opponent are validated
 * before anything acts on them, and the channel derives from the first key
 * the opponent sends — never a later, different one.
 */
import { describe, it, expect } from 'vitest';
import { generateGameKeyPair, sealPeerPayload, deriveGameChannel } from '../gameKeys';
import { parsePeerPayload, PeerChannel } from '../peerChannel';
import { normalizeField } from '../privateGame';
import { record } from './privateGameFixtures';

const TX = '0x' + 'ab'.repeat(32);

describe('peer payload validation', () => {
  it('accepts the four Phase A payloads', () => {
    expect(parsePeerPayload({ kind: 'RECORD', record: record(1) })).toEqual({ kind: 'RECORD', record: record(1) });
    expect(parsePeerPayload({ kind: 'SETTLING', prizeMove: 3 })).toEqual({ kind: 'SETTLING', prizeMove: 3 });
    expect(parsePeerPayload({ kind: 'SETTLING', prizeMove: null })).toEqual({ kind: 'SETTLING', prizeMove: null });
    expect(parsePeerPayload({ kind: 'SETTLED', txHash: TX.toUpperCase().replace('0X', '0x') })).toEqual({ kind: 'SETTLED', txHash: TX });
    expect(parsePeerPayload({ kind: 'CANCELLED' })).toEqual({ kind: 'CANCELLED' });
  });

  it('accepts Phase B\'s open cards, normalising the proof\'s public inputs', () => {
    const p = parsePeerPayload({ kind: 'OPEN_CARDS', cards: [21, 22, 23], proof: btoa('p'), publicInputs: ['9', '21', '0x16', '23'] });
    expect(p).toEqual({ kind: 'OPEN_CARDS', cards: [21, 22, 23], proof: btoa('p'), publicInputs: [9, 21, 22, 23].map(normalizeField) });
    expect(() => parsePeerPayload({ kind: 'OPEN_CARDS', cards: [21, 22], proof: btoa('p'), publicInputs: ['9', '21', '22', '23'] })).toThrow();
    expect(() => parsePeerPayload({ kind: 'OPEN_CARDS', cards: [21, 22, 23], proof: 7, publicInputs: ['9', '21', '22', '23'] })).toThrow();
  });

  it('normalises a record\'s fields (decimal, short hex) to the canonical form', () => {
    const p = parsePeerPayload({ kind: 'RECORD', record: ['1', '0x2', '3', '4', '5', '6', '7', '8', '9'] });
    expect(p).toEqual({ kind: 'RECORD', record: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n].map(normalizeField) });
  });

  it('refuses anything malformed', () => {
    expect(() => parsePeerPayload(null)).toThrow();
    expect(() => parsePeerPayload({ kind: 'RECORD', record: ['1'] })).toThrow();
    expect(() => parsePeerPayload({ kind: 'SETTLING', prizeMove: 9 })).toThrow(/prize move/);
    expect(() => parsePeerPayload({ kind: 'SETTLING', prizeMove: 1.5 })).toThrow(/prize move/);
    expect(() => parsePeerPayload({ kind: 'SETTLED', txHash: '0x123' })).toThrow(/tx hash/);
    // Nothing that carries notes, addresses or secrets has a payload kind.
    expect(() => parsePeerPayload({ kind: 'PLAINTEXT_NOTES', notes: [] })).toThrow(/unknown/);
  });
});

describe('PeerChannel', () => {
  it('both sides derive the same game key and open each other\'s payloads', async () => {
    const alice = new PeerChannel('room-1', await generateGameKeyPair());
    const bob = new PeerChannel('room-1', await generateGameKeyPair());
    expect(alice.isReady).toBe(false);
    await alice.setOpponentKey(bob.keyPair.publicKey);
    await bob.setOpponentKey(alice.keyPair.publicKey);
    expect(alice.gameKey).toBe(bob.gameKey);
    expect(alice.opponentPublicKey).toBe(bob.keyPair.publicKey);

    const sealed = await alice.seal({ kind: 'SETTLING', prizeMove: 5 });
    expect(sealed.ciphertext).not.toContain('SETTLING');
    await expect(bob.open(sealed)).resolves.toEqual({ kind: 'SETTLING', prizeMove: 5 });
  });

  it('sealing waits for the channel, so an early send is not lost', async () => {
    const alice = new PeerChannel('room-1', await generateGameKeyPair());
    const bob = new PeerChannel('room-1', await generateGameKeyPair());
    const pending = alice.seal({ kind: 'CANCELLED' });
    await alice.setOpponentKey(bob.keyPair.publicKey);
    await bob.setOpponentKey(alice.keyPair.publicKey);
    await expect(bob.open(await pending)).resolves.toEqual({ kind: 'CANCELLED' });
  });

  it('keeps the first opponent key: a different one later is refused', async () => {
    const alice = new PeerChannel('room-1', await generateGameKeyPair());
    const bob = await generateGameKeyPair();
    const mallory = await generateGameKeyPair();
    await alice.setOpponentKey(bob.publicKey);
    const key = alice.gameKey;
    await expect(alice.setOpponentKey(bob.publicKey)).resolves.toBeTruthy(); // same key: idempotent
    await expect(alice.setOpponentKey(mallory.publicKey)).rejects.toThrow(/different key/);
    expect(alice.gameKey).toBe(key);
  });

  it('seals and opens MOVE bodies; a MOVE is never taken for a PEER payload or the other way round', async () => {
    const alice = new PeerChannel('room-1', await generateGameKeyPair());
    const bob = new PeerChannel('room-1', await generateGameKeyPair());
    await alice.setOpponentKey(bob.keyPair.publicKey);
    await bob.setOpponentKey(alice.keyPair.publicKey);
    const move = { cardId: 21, slot: 3, row: 0, col: 2, proof: btoa('proof'), publicInputs: Array.from({ length: 8 }, (_, i) => normalizeField(i)) };
    const sealed = await alice.sealMove(move);
    expect(sealed.ciphertext).not.toContain('cardId');
    await expect(bob.openMove(sealed)).resolves.toEqual(move);
    // The same key seals both, so each opener checks the shape it expects.
    await expect(bob.open(sealed)).rejects.toThrow(/unknown peer payload/);
    await expect(bob.openMove(await alice.seal({ kind: 'CANCELLED' }))).rejects.toThrow();
    // A MOVE sealed for another room does not open here.
    const otherRoom = new PeerChannel('room-2', alice.keyPair);
    await otherRoom.setOpponentKey(bob.keyPair.publicKey);
    await expect(bob.openMove(await otherRoom.sealMove(move))).rejects.toThrow();
  });

  it('refuses a payload that opens but is not a valid payload', async () => {
    const aliceKeys = await generateGameKeyPair();
    const bob = new PeerChannel('room-1', await generateGameKeyPair());
    await bob.setOpponentKey(aliceKeys.publicKey);
    const raw = await deriveGameChannel(aliceKeys, bob.keyPair.publicKey, 'room-1');
    const forged = await sealPeerPayload(raw.channelKey, 'room-1', { kind: 'PLAINTEXT_NOTES', notes: [{ tokenId: 1 }] });
    await expect(bob.open(forged)).rejects.toThrow(/unknown peer payload/);
  });
});
