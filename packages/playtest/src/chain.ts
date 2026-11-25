/**
 * Harness-side chain client — the third pair of eyes, independent of both
 * browser PXEs, so "the frontend thinks it settled but the chain disagrees"
 * is caught here.
 *
 * A private game leaves no public state (docs/plan/PRIVATE_GAMES.md): no
 * status, no players, no events. Its whole on-chain footprint is a set of
 * siloed nullifiers derived from the game key and the two records only its
 * players hold (section 3.3). So the harness takes the key and records from
 * the players' stored games (PlayerDriver.storedGame), has the Game contract's
 * own `game_nullifiers` utility compute the 21 nullifiers in the harness's OWN
 * ephemeral wallet, and asks the node which exist and in which block.
 *
 * Mirrors the Node wallet pattern of scripts/deploy-contracts.ts and
 * packages/integration/tests (ephemeral EmbeddedWallet + Contract.at).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ROOT, PXE_URL, type ContractAddresses } from './env.js';

/** What `game_nullifiers` takes: the shared key and both records (record 2 may be unknown yet). */
export interface GameRef {
  gameKey: string;
  record1: string[];
  record2: string[] | null;
}

export type Side = 1 | 2;
export type ClaimNo = 1 | 2 | 3;

const RECORD_LEN = 9;

/**
 * The names of `game_nullifiers`' 21 results, in the contract's order
 * (packages/contracts/triple_triad_game/src/main.nr): `[created, seat2,
 * joined, done, claim_slot(1..3), claim(1,1), claim(1,2), claim(2,1),
 * claim(2,2), claim(3,1), claim(3,2), contested_by(1), contested_by(2),
 * contest(1..3), resolved(1..3)]`.
 *
 * Read from the contract, not imported from the frontend: a validator that
 * shared the app's own reading of the order would agree with any bug in it.
 */
export const GAME_NULLIFIER_NAMES = [
  'created', 'seat2', 'joined', 'done',
  'claim_slot(1)', 'claim_slot(2)', 'claim_slot(3)',
  'claim(1,1)', 'claim(1,2)', 'claim(2,1)', 'claim(2,2)', 'claim(3,1)', 'claim(3,2)',
  'contested_by(1)', 'contested_by(2)',
  'contest(1)', 'contest(2)', 'contest(3)',
  'resolved(1)', 'resolved(2)', 'resolved(3)',
] as const;

export type GameNullifierName = typeof GAME_NULLIFIER_NAMES[number];

/** One game's on-chain state: which of its nullifiers exist, and where. */
export interface GameChainState {
  /** The 21 siloed nullifiers, canonical hex, in `game_nullifiers` order. */
  nullifiers: string[];
  /** The block each landed in, or null while it does not exist. */
  blocks: (number | null)[];
  /** The names of the nullifiers that exist, in `game_nullifiers` order. */
  present: GameNullifierName[];
}

/** A tx found by one of its nullifiers. */
export interface ChainTx {
  txHash: string;
  /** The tx's non-zero note hashes. */
  noteHashes: string[];
  nullifiers: string[];
}

/** Canonical field hex (0x + 64 lowercase digits) — decimal or hex in, one form out. */
export function canonicalField(value: unknown): string {
  const s = typeof value === 'bigint' ? value.toString() : String(value).trim();
  const n = BigInt(s);
  if (n < 0n) throw new Error(`not a field element: ${s}`);
  return '0x' + n.toString(16).padStart(64, '0');
}

export function nullifierOf(state: GameChainState, name: GameNullifierName): string {
  return state.nullifiers[GAME_NULLIFIER_NAMES.indexOf(name)];
}

export function blockOf(state: GameChainState, name: GameNullifierName): number | null {
  return state.blocks[GAME_NULLIFIER_NAMES.indexOf(name)];
}

export class ChainClient {
  private constructor(
    private readonly node: any,
    private readonly gameContract: any,
    private readonly Fr: any,
    private readonly fromAddr: any,
    private readonly nullifierTree: number,
  ) {}

  static async connect(addresses: ContractAddresses): Promise<ChainClient> {
    const [
      { createAztecNodeClient }, { EmbeddedWallet }, { Fr }, { AztecAddress }, { GrumpkinScalar },
      { Contract }, { loadContractArtifact }, { MerkleTreeId },
    ] = await Promise.all([
      import('@aztec-labs/aztec.js/node'),
      import('@aztec-labs/wallets/embedded'),
      import('@aztec-labs/aztec.js/fields'),
      import('@aztec-labs/aztec.js/addresses'),
      import('@aztec-labs/foundation/curves/grumpkin'),
      import('@aztec-labs/aztec.js/contracts'),
      import('@aztec-labs/aztec.js/abi'),
      import('@aztec-labs/stdlib/trees'),
    ]);

    const node = createAztecNodeClient(PXE_URL);
    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    // Reads only — a registered (undeployed) account supplies the `from`.
    const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());

    const gameArtifactRaw = JSON.parse(readFileSync(
      resolve(ROOT, 'packages/contracts/target/triple_triad_game-TripleTriadGame.json'), 'utf-8'));
    const gameArtifact = loadContractArtifact(gameArtifactRaw);
    const gameAddr = AztecAddress.fromStringUnsafe(addresses.game);
    const instance = await node.getContract(gameAddr);
    if (!instance) throw new Error(`Game contract not found on-chain at ${addresses.game}`);
    await wallet.registerContract(instance, gameArtifact);
    const gameContract = await Contract.at(gameAddr, gameArtifact, wallet);

    return new ChainClient(node, gameContract, Fr, account.address, MerkleTreeId.NULLIFIER_TREE);
  }

  private fr(value: string) {
    return this.Fr.fromHexString(canonicalField(value));
  }

  private record(values: string[] | null): unknown[] {
    if (values === null) return Array.from({ length: RECORD_LEN }, () => new this.Fr(0n));
    if (values.length !== RECORD_LEN) throw new Error(`a record has ${RECORD_LEN} fields, got ${values.length}`);
    return values.map(v => this.fr(v));
  }

  /** The game's 21 siloed nullifiers, computed by the Game contract itself. */
  async gameNullifiers(ref: GameRef): Promise<string[]> {
    const { result } = await this.gameContract.methods
      .game_nullifiers(this.fr(ref.gameKey), this.record(ref.record1), this.record(ref.record2))
      .simulate({ from: this.fromAddr });
    const out = Array.from(result as ArrayLike<unknown>).map(canonicalField);
    if (out.length !== GAME_NULLIFIER_NAMES.length) {
      throw new Error(`game_nullifiers returned ${out.length} values, expected ${GAME_NULLIFIER_NAMES.length}`);
    }
    return out;
  }

  /** Which of `nullifiers` (siloed) exist, and the block each landed in. */
  async lookup(nullifiers: string[]): Promise<(number | null)[]> {
    const found = await this.node.findLeavesIndexes('latest', this.nullifierTree, nullifiers.map(n => this.fr(n)));
    if (found.length !== nullifiers.length) {
      throw new Error(`nullifier lookup returned ${found.length} results for ${nullifiers.length} nullifiers`);
    }
    return found.map((hit: { l2BlockNumber: number | bigint } | undefined) => (hit ? Number(hit.l2BlockNumber) : null));
  }

  /** The game's state, as the node sees it now. */
  async gameState(ref: GameRef): Promise<GameChainState> {
    const nullifiers = await this.gameNullifiers(ref);
    const blocks = await this.lookup(nullifiers);
    const present = GAME_NULLIFIER_NAMES.filter((_, i) => blocks[i] !== null);
    return { nullifiers, blocks, present };
  }

  /**
   * Poll until the game's set of existing nullifiers is exactly `expected`
   * (in `game_nullifiers` order). Returns the state. Throws with the last set
   * seen — a nullifier the node never shows is a real failure, not a slow read.
   */
  async waitForState(ref: GameRef, expected: GameNullifierName[], timeoutMs: number, label: string): Promise<GameChainState> {
    const want = GAME_NULLIFIER_NAMES.filter(n => expected.includes(n));
    const deadline = Date.now() + timeoutMs;
    let last: GameChainState | null = null;
    while (Date.now() < deadline) {
      last = await this.gameState(ref);
      if (JSON.stringify(last.present) === JSON.stringify(want)) return last;
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`${label}: the game's nullifiers never became ${JSON.stringify(want)} within ` +
      `${timeoutMs / 1000}s (last: ${JSON.stringify(last?.present)})`);
  }

  /** The tx in `blockNumber` that emitted `nullifier` (siloed), or null. */
  async txWithNullifier(blockNumber: number, nullifier: string): Promise<ChainTx | null> {
    const block = await this.node.getBlock(blockNumber, { includeTransactions: true });
    const target = canonicalField(nullifier);
    for (const effect of block?.body?.txEffects ?? []) {
      const nullifiers: string[] = (effect.nullifiers ?? []).map((n: { toString(): string }) => canonicalField(n.toString()));
      if (!nullifiers.includes(target)) continue;
      const noteHashes: string[] = (effect.noteHashes ?? [])
        .map((h: { toString(): string }) => canonicalField(h.toString()))
        .filter((h: string) => BigInt(h) !== 0n);
      return { txHash: canonicalField(effect.txHash.toString()), noteHashes, nullifiers };
    }
    return null;
  }

  /** The tx that pushed the game's `name` nullifier; throws if it does not exist. */
  async txOf(state: GameChainState, name: GameNullifierName): Promise<ChainTx> {
    const block = blockOf(state, name);
    if (block === null) throw new Error(`the game's '${name}' nullifier is not on-chain`);
    const tx = await this.txWithNullifier(block, nullifierOf(state, name));
    if (!tx) throw new Error(`block ${block} holds the game's '${name}' nullifier, but no tx in it carries it`);
    return tx;
  }
}
