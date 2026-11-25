/**
 * Fakes for the bot's chain, prover, key exchange and opponent.
 *
 * The chain fake models what the bot relies on and nothing more: which of a
 * game's 21 nullifiers exist (and in which block), the tx that pushed one,
 * which of the bot's prepared notes a tx released, and what an import actually
 * makes visible — so a test can assert that cards CAME BACK, not merely that
 * an import was called.
 *
 * The opponent (FakeHuman) is the creator's side of a game as a browser plays
 * it since the relay stopped running the game (docs/plan/PRIVATE_GAMES.md
 * section 6): its own record, open cards and sealed moves, built with the
 * frontend's own game model, and the frontend's own checks of every move the
 * bot sends. Only the cryptography is stood in for — a deterministic state
 * hash (or the real pedersen one) and verifiers that accept.
 */
import { EventEmitter } from 'events';
import { chooseBotMove } from '@axolotl-arena/game-logic';
import { ArenaBot, type GameKeysLike, type QueueSnapshot } from '../src/ArenaBot.js';
import type { ArenaBotConfig } from '../src/config.js';
import type { BotProofsLike, MoveProofArgs } from '../src/chainTypes.js';
import type { JournalRecord, JournalResolution } from '../src/GameJournal.js';
import type { MoveProofData } from '../../frontend/src/types.js';
import type { FoundTx } from '../../frontend/src/aztec/gameChain.js';
import type { SealedPayload } from '../../frontend/src/aztec/gameKeys.js';
import {
  NULLIFIER_INDEX,
  normalizeField,
  type ClaimNo,
  type GameSecrets,
  type Side,
} from '../../frontend/src/aztec/privateGame.js';
import {
  encodeBoardState,
  encodeOriginalOwners,
  expectedMoveInputs,
  expectedOpenCardsInputs,
  moveProofFromOutput,
  moveStateHashes,
  parseMovePayload,
  parseOpenCardsPayload,
  planOwnMove,
  replay,
  type GameMove,
  type LocalGameFacts,
  type MovePayload,
  type OpenCardsPayload,
  type StateHasher,
  type TranscriptMove,
} from '../../frontend/src/aztec/localGame.js';
import { checkOpenCards, checkOpponentMove, type ProofChecks } from '../../frontend/src/aztec/moveChecks.js';
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

/**
 * How a played-out game between these two hands ends, with the bot on
 * `moveSeed: 1` (greedy, full skill). Ranks are per card id from a fixed
 * database, so an outcome cannot be arranged by difficulty alone; these were
 * found by playing the pair out. `firstFree` places the human's cards in slot
 * order on the first empty cell; `greedy` is game-logic's own strategy.
 */
export const OUTCOMES = {
  /** The bot loses: the human wins 9-1. */
  loss: { kind: 'firstFree' } as HumanStrategy,
  /** The bot wins 7-3; the human places 247, the bot's prize, at move 2. */
  win: { kind: 'greedy', seed: 7 } as HumanStrategy,
  /** 5-5. */
  draw: { kind: 'greedy', seed: 1 } as HumanStrategy,
};
export const BOT_SEED = 1;

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

// ─── Cryptography stand-ins ─────────────────────────────────────────────────

/** A deterministic stand-in for pedersen over the 30-field state (FNV-1a, 64 bits). */
export const fakeHashState: StateHasher = async (board, scores, turn, owners) => {
  let h = 0xcbf29ce484222325n;
  for (const v of [...board, ...scores.map(String), String(turn), ...owners.map(String)]) {
    for (const ch of v + '|') h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & ((1n << 64n) - 1n);
  }
  return normalizeField(h);
};

/** Checks with a state hasher (the stand-in by default) and verifiers that accept. */
export function fakeChecks(over: Partial<ProofChecks> = {}): ProofChecks {
  return {
    hashState: fakeHashState,
    verifyMove: async () => true,
    verifyOpenCards: async () => true,
    ...over,
  };
}

/**
 * A move proof shaped exactly as the real prover shapes it for `args`: the
 * state hashes of the boards before (mover to play) and after (the other
 * player to play), the result, and the placed card and its committed slot.
 */
export async function proveLike(args: MoveProofArgs, hashState: StateHasher = fakeHashState): Promise<MoveProofData> {
  const other = args.currentPlayer === 1 ? 2 : 1;
  const start = await hashState(encodeBoardState(args.boardBefore), args.scoresBefore, args.currentPlayer, encodeOriginalOwners(args.boardBefore));
  const end = await hashState(encodeBoardState(args.boardAfter), args.scoresAfter, other, encodeOriginalOwners(args.boardAfter));
  const slot = args.hand.cardIds.indexOf(args.cardId);
  if (slot < 0) throw new Error(`card ${args.cardId} is not in the committed hand`);
  return moveProofFromOutput(fakeProofB64(), [
    args.cardCommit1, args.cardCommit2, start, end,
    args.gameEnded ? 1 : 0, args.winnerId, args.cardId, slot,
  ].map(v => normalizeField(v)));
}

/** An open-cards "proof" with the public inputs the real one carries. */
export function openCardsLike(hand: number[], handCommit: string): OpenCardsPayload {
  const cards = hand.slice(0, 3);
  return { cards, proof: fakeProofB64(), publicInputs: expectedOpenCardsInputs(handCommit, cards) };
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
    } as GameKeysLike,
    /** What the human would put on the wire for `payload`. */
    seal: sealed,
    /** Read a PEER or MOVE the bot sent. */
    open: (msg: { ciphertext: string }) => JSON.parse(Buffer.from(msg.ciphertext, 'base64').toString()).payload,
  };
}

// ─── The opponent ───────────────────────────────────────────────────────────

export type HumanStrategy = { kind: 'firstFree' } | { kind: 'greedy'; seed: number };

/** A MOVE as the relay forwards it. */
export interface RelayMove extends SealedPayload {
  type: 'MOVE';
  gameId: string;
  moveNumber: number;
}

/**
 * The creator, player 1, as a browser plays a game: its own record (RECORD1),
 * its three open cards, sealed moves whose public inputs are what the bot's
 * board will expect — and the frontend's own checks of everything the bot
 * sends, so a bot move a real client would refuse fails the test.
 */
export class FakeHuman {
  readonly hand: number[];
  readonly checks: ProofChecks;
  /** The transcript as the human holds it. */
  readonly moves: TranscriptMove[] = [];
  /** The bot's open cards, once they checked out. */
  botOpen: number[] | null = null;
  private readonly strategy: HumanStrategy;

  constructor(private readonly opts: {
    room: string;
    seal: (payload: unknown) => Promise<SealedPayload>;
    open: (sealed: SealedPayload) => Promise<unknown>;
    hand?: number[];
    strategy?: HumanStrategy;
    checks?: ProofChecks;
  }) {
    this.hand = opts.hand ?? HUMAN_HAND;
    this.strategy = opts.strategy ?? { kind: 'firstFree' };
    this.checks = opts.checks ?? fakeChecks();
  }

  get room(): string { return this.opts.room; }

  /** Both hand commitments, as both records carry them. */
  get commits() { return { commit1: RECORD1[1], commit2: RECORD2[1] }; }

  facts(): LocalGameFacts {
    return { role: 1, ownHand: this.hand, opponentOpen: this.botOpen, moves: this.moves };
  }

  /** Our next move, by strategy. */
  plan(): GameMove {
    const facts = this.facts();
    const r = replay(facts);
    let choice = { handIndex: 0, row: -1, col: -1 };
    if (this.strategy.kind === 'greedy') {
      choice = chooseBotMove(r.state, { difficulty: 'greedy', skill: 1, seed: this.strategy.seed });
    } else {
      outer: for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          if (!r.state.board[row][col].card) { choice = { handIndex: 0, row, col }; break outer; }
        }
      }
    }
    return planOwnMove(facts, r, choice.handIndex, choice.row, choice.col);
  }

  /** What an honest browser sends for `move`: the public inputs of the boards before and after it. */
  async payloadFor(move: GameMove): Promise<MovePayload> {
    const facts = this.facts();
    const before = replay(facts).state;
    const after = replay({ ...facts, moves: [...facts.moves, move] }).state;
    const hashes = await moveStateHashes(before, after, 1, this.checks.hashState);
    return {
      cardId: move.cardId, slot: move.slot, row: move.row, col: move.col,
      proof: fakeProofB64(),
      publicInputs: expectedMoveInputs({ ...this.commits, hashes, after, move }),
    };
  }

  /**
   * Make our next move: into our transcript, and onto the wire. `tamper`
   * rewrites the payload before it is sealed — what a cheating client sends.
   */
  async move(tamper?: (p: MovePayload) => void): Promise<RelayMove> {
    const move = this.plan();
    const payload = await this.payloadFor(move);
    tamper?.(payload);
    this.moves.push({ ...move, proof: moveProofFromOutput(payload.proof, payload.publicInputs) });
    return this.frame(move.moveNumber, payload);
  }

  /** Seal anything as MOVE `moveNumber`. */
  async frame(moveNumber: number, payload: unknown): Promise<RelayMove> {
    return { type: 'MOVE', gameId: this.room, moveNumber, ...(await this.opts.seal(payload)) };
  }

  /** The bot's MOVE, opened and checked exactly as the human's browser does it. Throws if it would be refused. */
  async receive(msg: { moveNumber: number; iv: string; ciphertext: string }): Promise<TranscriptMove> {
    const payload = parseMovePayload(await this.opts.open(msg));
    const result = await checkOpponentMove(this.facts(), this.commits, msg.moveNumber, payload, this.checks);
    if (!result.ok) throw new Error(`the human's client refuses the bot's move ${msg.moveNumber}: ${result.reason}`);
    this.moves.push(result.value);
    return result.value;
  }

  /** Our OPEN_CARDS payload: the committed hand's slots 0..2, against our record. */
  openCards(): { kind: 'OPEN_CARDS' } & OpenCardsPayload {
    return { kind: 'OPEN_CARDS', ...openCardsLike(this.hand, RECORD1[1]) };
  }

  /** The bot's OPEN_CARDS, checked as the human's browser does it. */
  async receiveOpenCards(p: Record<string, unknown>): Promise<void> {
    const result = await checkOpenCards(this.facts(), RECORD2[1], parseOpenCardsPayload(p), this.checks);
    if (!result.ok) throw new Error(`the human's client refuses the bot's open cards: ${result.reason}`);
    this.botOpen = result.value;
  }
}

// ─── The chain ──────────────────────────────────────────────────────────────

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

/**
 * The bot's prover and referee, faked: move proofs shaped exactly as the real
 * prover shapes them (with `checks.hashState` for the state hashes), open
 * cards with the right public inputs, and `checks` for the opponent's.
 */
export function fakeProofs(checks: ProofChecks = fakeChecks(), over: Partial<BotProofsLike> = {}) {
  const proved: MoveProofArgs[] = [];
  const openProved: { hand: number[]; blinding: string; handCommit: string }[] = [];
  const proofs: BotProofsLike = {
    cardCommitHash: async () => RECORD2[1],
    moveVerificationKey: async () => new Uint8Array(32 * 4),
    proveMove: async (a: MoveProofArgs) => { proved.push(a); return proveLike(a, checks.hashState); },
    proveOpenCards: async (hand, blinding, handCommit) => {
      openProved.push({ hand: [...hand], blinding, handCommit });
      return openCardsLike(hand, handCommit);
    },
    check: run => run(checks),
    prepareChecks: async () => {},
    ...over,
  };
  return { proofs, proved, openProved };
}

// ─── The bot under test ─────────────────────────────────────────────────────

/**
 * Minimal stand-in for the `ws` client: records what the bot sends. Like a
 * real one it is CONNECTING until 'open' and closes once.
 */
export class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === 'open') this.readyState = 1;
    return super.emit(event, ...args);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
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
    difficulty: 'greedy', moveDelayMs: 0,
    // Full strength by default in tests: a bot that blunders at random makes
    // every move assertion flaky for reasons unrelated to what is being tested.
    skillMin: 1, skillMax: 1,
    moveSeed: BOT_SEED,
    maxConcurrentGames: 1,
    chainTxTimeoutMs: 600_000,
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
 * A bot on fake sockets, chain, prover, journal and key exchange, and a
 * scripted human to play it. `wait` advances time:
 * vi.advanceTimersByTimeAsync under fake timers, a real sleep otherwise.
 * Every connection gets a fresh socket, as `ws` does; `socket` is the latest.
 */
export function chainBot(opts: {
  cfg?: Partial<ArenaBotConfig>;
  chain?: Record<string, unknown>;
  pxe?: Record<string, unknown>;
  proofs?: Partial<BotProofsLike>;
  /** The bot's referee (and the human's, unless `humanChecks` says otherwise). */
  checks?: ProofChecks;
  /** A bot that has no prover at all. */
  noProofs?: boolean;
  queue?: QueueSnapshot | (() => QueueSnapshot);
  now?: () => number;
  wait: (ms: number) => Promise<unknown>;
}) {
  const sockets: FakeSocket[] = [];
  const f = fakeChain({ chain: opts.chain, pxe: opts.pxe });
  // The creator's game is on-chain before they send their record.
  f.state.hits.set(N.created, 4);
  const k = fakeKeys();
  const j = journalSpy();
  const logs: string[] = [];
  const checks = opts.checks ?? fakeChecks();
  const p = fakeProofs(checks, opts.proofs);
  const queue = opts.queue ?? { length: 1, oldestWaitMs: 30_000, entries: [] };
  const bot = new ArenaBot(makeConfig(opts.cfg), {
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as any; },
    fetchQueue: async () => (typeof queue === 'function' ? queue() : queue),
    chain: f.chain as never,
    proofs: opts.noProofs ? undefined : p.proofs,
    journal: j.journal,
    keys: k.keys,
    log: m => logs.push(m),
    now: opts.now,
  });
  const h = {
    bot, f, k, j, logs, sockets, checks,
    proved: p.proved,
    openProved: p.openProved,
    /** The live connection. */
    get socket(): FakeSocket { return sockets[sockets.length - 1]; },
    /** Everything the bot sent of `type`, on every connection. */
    sent(type: string): any[] { return sockets.flatMap(s => s.ofType(type)); },
    /** Connect, register, and let one poll queue us (which picks our hand). */
    async ready() {
      bot.start();
      h.socket.emit('open');
      h.socket.deliver({ type: 'SESSION_ESTABLISHED', playerId: 'bot', sessionToken: 'session-1', resumed: false, gameId: null });
      h.socket.deliver({ type: 'BOT_REGISTERED' });
      await opts.wait((opts.cfg?.pollIntervalMs ?? 1_000) + 10);
    },
    /** The relay pairs us with the human, as player 2. */
    match(gameId = 'g1') {
      h.socket.deliver({ type: 'MATCH_FOUND', gameId, playerNumber: 2 });
    },
    /** The human's side of the key exchange, then their record. */
    handshake(gameId = 'g1', record = RECORD1) {
      h.socket.deliver({ type: 'OPPONENT_KEY', gameId, publicKey: HUMAN_PK });
      h.socket.deliver({ type: 'PEER', gameId, ...k.seal(gameId, { kind: 'RECORD', record }) });
    },
    /** A sealed payload from the human. */
    peer(gameId: string, payload: unknown) {
      h.socket.deliver({ type: 'PEER', gameId, ...k.seal(gameId, payload) });
    },
    /** The payloads the bot sealed to the human, on every connection. */
    sentPeers(): any[] {
      return h.sent('PEER').map(m => k.open(m));
    },
    /** A scripted human for game `gameId`, speaking the same (fake) channel. */
    human(o: { gameId?: string; strategy?: HumanStrategy; hand?: number[]; checks?: ProofChecks } = {}) {
      const room = o.gameId ?? 'g1';
      return new FakeHuman({
        room,
        seal: async payload => k.seal(room, payload),
        open: async sealed => k.open(sealed),
        strategy: o.strategy,
        hand: o.hand,
        checks: o.checks ?? checks,
      });
    },
    /** The bot's MOVE `n`, once it has been sent (on any connection). */
    async botMove(n: number, tries = 200): Promise<any> {
      for (let i = 0; i < tries; i++) {
        const m = h.sent('MOVE').find(x => x.moveNumber === n);
        if (m) return m;
        await opts.wait(10);
      }
      throw new Error(`the bot never sent move ${n}`);
    },
    /**
     * Open the game from its first moments: match, key exchange, the human's
     * record, the join, and both sides' open cards (each checked by the other).
     */
    async begin(human: FakeHuman, gameId = 'g1') {
      h.match(gameId);
      h.handshake(gameId);
      await opts.wait(50);
      if (f.called('join').length !== 1) throw new Error('the bot did not join');
      h.peer(gameId, human.openCards());
      await opts.wait(50);
      const theirs = h.sentPeers().find(pl => pl.kind === 'OPEN_CARDS');
      if (!theirs) throw new Error('the bot sent no open cards');
      await human.receiveOpenCards(theirs);
    },
    /**
     * Play on until the transcript holds `moves` moves (all nine by default):
     * the human moves on its turns, and checks each of the bot's as its
     * browser would.
     */
    async playTo(human: FakeHuman, moves = 9) {
      while (human.moves.length < moves) {
        const n = human.moves.length;
        if (n % 2 === 0) {
          h.socket.deliver(await human.move());
          await opts.wait(20);
        } else {
          await human.receive(await h.botMove(n));
        }
      }
    },
  };
  return h;
}
