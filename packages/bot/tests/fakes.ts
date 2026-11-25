/**
 * Fakes for the bot's chain, key exchange and transcripts.
 *
 * The chain fake models what the bot relies on and nothing more: which of a
 * game's 21 nullifiers exist (and in which block), the tx that pushed one,
 * which of the bot's prepared notes a tx released, and what an import actually
 * makes visible — so a test can assert that cards CAME BACK, not merely that
 * an import was called.
 */
import { EventEmitter } from 'events';
import { ArenaBot, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import type { BotProofsLike, MoveProofArgs } from '../src/chainTypes.js';
import type { JournalRecord, JournalResolution } from '../src/GameJournal.js';
import type { MoveProofData } from '../../frontend/src/types.js';
import type { FoundTx } from '../../frontend/src/aztec/gameChain.js';
import { NULLIFIER_INDEX, type ClaimNo, type GameSecrets, type Side } from '../../frontend/src/aztec/privateGame.js';
import { normalizeMoveProof } from '../src/protocol.js';

/** A canonical field: 0x + 64 hex. */
export const F = (n: number | bigint) => '0x' + BigInt(n).toString(16).padStart(64, '0');

export const GAME_KEY = F(0x6a6a);
/** The creator's (human's) record, and the bot's. Index 1 is the hand commitment. */
export const RECORD1 = Array.from({ length: 9 }, (_, i) => F(0x100 + i));
export const RECORD2 = Array.from({ length: 9 }, (_, i) => F(0x200 + i));
export const NONCE = F(16);
export const SECRETS: GameSecrets = {
  blinding: F(0xb1),
  returns: [F(0xa0), F(0xa1), F(0xa2), F(0xa3), F(0xa4)],
  prize: F(0xa5),
  reward: F(0xa6),
};
export const BOT_HAND = [7, 8, 9, 10, 11];
/** Distinct rarities so the prize choice is unambiguous: 247 is legendary, 230 epic, 180 rare. */
export const HUMAN_HAND = [1, 180, 247, 2, 230];

/** The 21 siloed nullifiers `game_nullifiers` returns for the test game. */
export const NULLIFIERS = Array.from({ length: 21 }, (_, i) => F(0x9000 + i));
export const N = {
  created: NULLIFIERS[NULLIFIER_INDEX.created],
  joined: NULLIFIERS[NULLIFIER_INDEX.joined],
  done: NULLIFIERS[NULLIFIER_INDEX.done],
  claimSlot: (c: ClaimNo) => NULLIFIERS[NULLIFIER_INDEX.claimSlot(c)],
  claim: (c: ClaimNo, side: Side) => NULLIFIERS[NULLIFIER_INDEX.claim(c, side)],
  contestedBy: (side: Side) => NULLIFIERS[NULLIFIER_INDEX.contestedBy(side)],
  contest: (c: ClaimNo) => NULLIFIERS[NULLIFIER_INDEX.contest(c)],
  resolved: (c: ClaimNo) => NULLIFIERS[NULLIFIER_INDEX.resolved(c)],
};

/** Valid base64 for N 32-byte fields — the real settle-args builder decodes it. */
export const fakeProofB64 = (fields = 4) => Buffer.alloc(32 * fields).toString('base64');

/**
 * A nine-move transcript bound to RECORD1/RECORD2. Player 1 (the human)
 * places `human[0..4]` at moves 0,2,4,6,8; player 2 (the bot) places
 * `bot[0..3]` at 1,3,5,7. `start` is the first move's start state.
 */
export function transcript(opts: {
  winnerId: 1 | 2 | 3;
  human?: number[];
  bot?: number[];
  start?: string;
  moves?: number;
}): MoveProofData[] {
  const human = opts.human ?? HUMAN_HAND;
  const bot = opts.bot ?? BOT_HAND;
  const states = [opts.start ?? F(0x5000), ...Array.from({ length: 9 }, (_, i) => F(0x5001 + i))];
  const out: MoveProofData[] = [];
  for (let i = 0; i < (opts.moves ?? 9); i++) {
    const p1 = i % 2 === 0;
    const card = p1 ? human[i / 2] : bot[(i - 1) / 2];
    const slot = (p1 ? human : bot).indexOf(card);
    const last = i === 8;
    out.push(normalizeMoveProof({
      proof: fakeProofB64(),
      publicInputs: [
        RECORD1[1], RECORD2[1], states[i], states[i + 1],
        F(last ? 1 : 0), F(last ? opts.winnerId : 0), F(card), F(slot),
      ],
    })!);
  }
  return out;
}

/** The key exchange, deterministic and immediate (fake timers cannot wait on WebCrypto). */
export function fakeKeys() {
  const sealed = (room: string, payload: unknown) => ({
    iv: 'aXZpdml2aXZpdml2',
    ciphertext: Buffer.from(JSON.stringify({ room, payload })).toString('base64'),
  });
  return {
    keys: {
      generateGameKeyPair: async () => ({ privateJwk: { kty: 'EC', crv: 'P-256', d: 'bot-private' }, publicKey: 'Ym90LXB1Yg==' }),
      deriveGameChannel: async (_own: unknown, theirs: string, room: string) => ({
        gameKey: GAME_KEY, channelKey: { theirs, room } as unknown as CryptoKey,
      }),
      sealPeerPayload: async (_k: CryptoKey, room: string, payload: unknown) => sealed(room, payload),
      openPeerPayload: async <T>(_k: CryptoKey, room: string, s: { iv: string; ciphertext: string }): Promise<T> => {
        const { room: r, payload } = JSON.parse(Buffer.from(s.ciphertext, 'base64').toString());
        if (r !== room) throw new Error('OperationError: the associated data does not match');
        return payload as T;
      },
    },
    /** What the human would put on the wire for `payload`. */
    seal: sealed,
    /** Read a PEER the bot sent. */
    open: (msg: { ciphertext: string }) => JSON.parse(Buffer.from(msg.ciphertext, 'base64').toString()).payload,
  };
}

export interface FakeChainState {
  /** Nullifier → the block it landed in. */
  hits: Map<string, number>;
  /** Block → timestamp. Unlisted blocks get 1000 + 36·n. */
  blockTimes: Map<number, number>;
  /** Block → the tx that resolved the game in it. */
  txs: Map<number, FoundTx>;
  /** Chain time now (latest block's timestamp). */
  now: number;
  /** Cards the PXE can see. */
  cards: number[];
  /** What the resolving tx released of ours. */
  released: { returns: boolean[]; reward: boolean };
  /** Which imported card notes actually land: false for one that is not in the tx. */
  lands: (note: { tokenId: number; randomness: string }) => boolean;
}

export const RESOLVING_TX: FoundTx = {
  txHash: F(0x5e77),
  noteHashes: [F(0xe1), F(0xe2)],
  firstNullifier: F(0xf1),
};

/** A chain that knows one game: the test game. */
export function fakeChain(over: Record<string, any> = {}) {
  const calls: any[][] = [];
  const s: FakeChainState = {
    hits: new Map(), blockTimes: new Map(), txs: new Map(), now: 1_000_000, cards: [],
    released: { returns: [true, true, true, true, true], reward: true },
    lands: () => true,
  };
  /** Resolve the game in `block` with RESOLVING_TX (what a settle or finalize does). */
  const resolveIn = (block: number, extra: string[] = []) => {
    s.hits.set(N.done, block);
    for (const n of extra) s.hits.set(n, block);
    s.txs.set(block, RESOLVING_TX);
  };
  const pxe = {
    readNoteNonce: async (...a: any[]) => { calls.push(['nonce', ...a]); return NONCE; },
    computeGameSecrets: async (...a: any[]) => { calls.push(['secrets', ...a]); return SECRETS; },
    previewRecord: async (...a: any[]) => { calls.push(['preview', ...a]); return RECORD2; },
    gameNullifiers: async (...a: any[]) => { calls.push(['nullifiers', ...a]); return NULLIFIERS; },
    sendJoinGame: async (...a: any[]) => {
      calls.push(['join', ...a]);
      s.hits.set(N.joined, 5);
      return F(0x10a);
    },
    sendSettleGame: async (...a: any[]) => {
      calls.push(['settle', ...a]);
      resolveIn(40);
      return RESOLVING_TX.txHash;
    },
    sendClaimAbandonedGame: async (...a: any[]) => {
      calls.push(['claim', ...a]);
      const { side, claimNo } = a[2];
      s.hits.set(N.claimSlot(claimNo), 30);
      s.hits.set(N.claim(claimNo, side), 30);
      return F(0xc1a);
    },
    sendContestAbandonment: async (...a: any[]) => {
      calls.push(['contest', ...a]);
      const { side, claimNo } = a[2];
      s.hits.set(N.contestedBy(side), 31);
      s.hits.set(N.contest(claimNo), 31);
      s.hits.set(N.resolved(claimNo), 31);
      return F(0xc0e);
    },
    sendFinalizeAbandonedGame: async (...a: any[]) => {
      calls.push(['finalize', ...a]);
      resolveIn(50, [N.resolved(a[2].claimNo)]);
      return RESOLVING_TX.txHash;
    },
    importCardNotes: async (_o: string, txHash: string, notes: { tokenId: number; randomness: string }[]) => {
      calls.push(['importCards', txHash, notes]);
      for (const n of notes) if (s.lands(n)) s.cards.push(n.tokenId);
      return notes.map(n => n.tokenId);
    },
    importTokenRewardNote: async (...a: any[]) => { calls.push(['importReward', ...a]); return true; },
    ...over.pxe,
  };
  const chain = {
    address: '0xbot',
    nodeClient: { fake: 'node' },
    pxe,
    lookupNullifiers: async (ns: string[]) => ns.map(n => (s.hits.has(n) ? { blockNumber: s.hits.get(n)! } : null)),
    blockTimestamp: async (b: number) => s.blockTimes.get(b) ?? 1000 + 36 * b,
    chainNow: async () => s.now,
    findTxWithNullifier: async (b: number, n: string) => (s.hits.get(n) === b ? s.txs.get(b) ?? null : null),
    releasedPreparedNotes: async () => s.released,
    selectHand: async () => [...BOT_HAND],
    readCards: async () => [...s.cards],
    invalidateCards: () => {},
    ...over.chain,
  };
  const called = (name: string) => calls.filter(c => c[0] === name);
  return { chain, pxe, calls, called, state: s, resolveIn };
}

// ─── The bot under test ─────────────────────────────────────────────────────


/** Minimal stand-in for the `ws` client: records what the bot sends. */
export class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  /** Deliver a server frame to the bot. */
  deliver(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  lastOfType(type: string) { return [...this.sent].reverse().find(m => m.type === type); }
  ofType(type: string) { return this.sent.filter(m => m.type === type); }
  countOfType(type: string) { return this.sent.filter(m => m.type === type).length; }
}

export function makeConfig(over: Partial<ArenaBotConfig> = {}): ArenaBotConfig {
  return {
    wsUrl: 'ws://test', httpUrl: 'http://test', token: 'tok',
    joinThresholdMs: 20_000, pollIntervalMs: 1_000, queueTimeoutMs: 60_000,
    handCardIds: [1, 2, 3, 4, 5], difficulty: 'greedy', moveDelayMs: 0,
    // Full strength by default in tests: a bot that blunders at random makes
    // every move assertion flaky for reasons unrelated to what is being tested.
    skillMin: 1, skillMax: 1,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
    // Unit tests assert the IMMEDIATE verdict on an incomplete transcript.
    settleWaitMs: 0,
    sweepIntervalMs: 900_000,
    drawFallbackMs: 0,
    gameTimeoutMs: 1_800_000,
    opponentGraceMs: 90_000,
    healthPort: 0,
    ...over,
  };
}

/** The human's ephemeral public key, as the relay forwards it. */
export const HUMAN_PK = 'aHVtYW4tcHVi';

/** A move proof the way the real prover shapes it, for the move `args` describes. */
export function fakeMoveProof(args: MoveProofArgs): MoveProofData {
  const before = args.boardBefore.flat().filter(c => c.card !== null).length;
  const slot = args.hand.cardIds.indexOf(args.cardId);
  return normalizeMoveProof({
    proof: fakeProofB64(),
    publicInputs: [
      args.cardCommit1, args.cardCommit2, F(0x7000 + before), F(0x7000 + before + 1),
      F(args.gameEnded ? 1 : 0), F(args.winnerId), F(args.cardId), F(slot),
    ],
  })!;
}

/** A journal that records every write, in memory. */
export function journalSpy() {
  const store = new Map<string, JournalRecord>();
  const written: JournalRecord[] = [];
  const resolved: [string, JournalResolution, string][] = [];
  const forgotten: string[] = [];
  return {
    store, written, resolved, forgotten,
    journal: {
      read: (id: string) => store.get(id) ?? null,
      write: (rec: JournalRecord) => { store.set(rec.relayGameId, rec); written.push(JSON.parse(JSON.stringify(rec))); },
      forget: (id: string) => { store.delete(id); forgotten.push(id); },
      markResolved: (id: string, how: JournalResolution, tx: string) => {
        resolved.push([id, how, tx]);
        const rec = store.get(id);
        if (rec) store.set(id, { ...rec, resolution: how, resolvedTxHash: tx });
      },
      outstanding: () => [...store.values()].filter(r => !r.resolution),
    },
  };
}

/**
 * A chain-mode bot on a fake socket, chain, prover, journal and key exchange.
 * `wait` advances time: vi.advanceTimersByTimeAsync under fake timers, a real
 * sleep otherwise.
 */
export function chainBot(opts: {
  cfg?: Partial<ArenaBotConfig>;
  chain?: Record<string, unknown>;
  pxe?: Record<string, unknown>;
  proofs?: Partial<BotProofsLike> | null;
  queue?: QueueSnapshot;
  now?: () => number;
  wait: (ms: number) => Promise<unknown>;
}) {
  const socket = new FakeSocket();
  const f = fakeChain({ chain: opts.chain, pxe: opts.pxe });
  // The creator's game is on-chain before they send their record.
  f.state.hits.set(N.created, 4);
  const k = fakeKeys();
  const j = journalSpy();
  const logs: string[] = [];
  const proved: MoveProofArgs[] = [];
  const proofs: BotProofsLike | undefined = opts.proofs === null ? undefined : {
    cardCommitHash: async () => RECORD2[1],
    moveVerificationKey: async () => new Uint8Array(32 * 4),
    proveMove: async (a: MoveProofArgs) => { proved.push(a); return fakeMoveProof(a); },
    ...opts.proofs,
  };
  const bot = new ArenaBot(makeConfig(opts.cfg), {
    connect: () => socket as unknown as any,
    fetchQueue: async () => opts.queue ?? { length: 1, oldestWaitMs: 30_000, entries: [] },
    chain: f.chain as never,
    proofs,
    journal: j.journal,
    keys: k.keys,
    log: m => logs.push(m),
    now: opts.now,
  });
  return {
    bot, socket, f, k, j, logs, proved,
    /** Connect, register, and let one poll queue us (which picks our hand). */
    async ready() {
      bot.start();
      socket.emit('open');
      socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 't' });
      socket.deliver({ type: 'BOT_REGISTERED' });
      await opts.wait((opts.cfg?.pollIntervalMs ?? 1_000) + 10);
    },
    /** The human's side of the key exchange, then their record. */
    handshake(gameId = 'g1', record = RECORD1) {
      socket.deliver({ type: 'OPPONENT_KEY', gameId, publicKey: HUMAN_PK });
      socket.deliver({ type: 'PEER', gameId, ...k.seal(gameId, { kind: 'RECORD', record }) });
    },
    /** A sealed payload from the human. */
    peer(gameId: string, payload: unknown) {
      socket.deliver({ type: 'PEER', gameId, ...k.seal(gameId, payload) });
    },
    /** The payloads the bot sealed to the human. */
    sentPeers() {
      return socket.ofType('PEER').map(m => k.open(m));
    },
  };
}
