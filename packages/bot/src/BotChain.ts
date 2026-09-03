/**
 * The bot's chain adapter.
 *
 * Thin on purpose. Everything substantive — contract resolution, the send
 * queue, anchor-sync-before-send, reorg retries — already lives in the
 * frontend's pxe.ts, and the bot reuses it verbatim. This file only does the
 * bootstrap the browser does elsewhere (in connectToAztec): point the artifact
 * loaders at the filesystem, build the wallet from the provisioned identity,
 * register the contracts, and bind the wallet to the ops layer.
 *
 * Deliberately NOT a second implementation of the game's chain flow. A parallel
 * one could drift from what players actually execute, and that drift would stay
 * invisible until a settlement proof was rejected on-chain.
 *
 * ONE IDENTITY PER PROCESS. pxe.ts binds the wallet in a module-level global
 * (`currentWallet`, set by setPxeWallet), so a second BotChain in the same
 * process silently rebinds the ops layer to the newer wallet and BOTH identities
 * then act as the last one connected. The identity pool (docs/plan/
 * BACKEND_OPPONENT.md §2b) therefore runs as N processes, not one process with N
 * identities — which is also better for CPU isolation, since proving is the
 * bottleneck. Guarded below.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { installNodeArtifactSources } from './circuits.js';
import { identityDataDirectory } from './dataDir.js';

export interface BotIdentity {
  index: number;
  address: string;
  secret: string;
  salt: string;
  signingKey: string;
  cardIds: number[];
  rollupVersion: number;
  /** Note plaintexts to import — see importStock(). */
  notes?: { tokenId: number; randomness: string; txHash: string }[];
}

export interface BotChainConfig {
  /** Manifest location. Sandbox and testnet sets must not share a directory —
   *  the manifest is the only record of an untagged note's plaintext. */
  pxeUrl: string;
  nftAddress: string;
  gameAddress: string;
  tokenAddress?: string;
  /** Path to the manifest written by scripts/provision-arena-bot.ts. */
  manifestPath: string;
  circuitsDir?: string;
  contractsDir?: string;
}

type Logger = (msg: string) => void;

export function loadBotIdentity(manifestPath: string): BotIdentity {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Arena bot manifest not found: ${manifestPath}. Provision the bot first:\n` +
      `  npx tsx scripts/provision-arena-bot.ts --cards 40`,
    );
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BotIdentity;
  for (const key of ['address', 'secret', 'salt', 'signingKey'] as const) {
    if (!m[key]) throw new Error(`Arena bot manifest is missing '${key}' — re-provision`);
  }
  return m;
}

/** Gap between import transactions. The public testnet RPC rate-limits well
 *  before it runs out of capacity, and importing a deep stock is the burstiest
 *  thing the bot ever does. */
const IMPORT_PACE_MS = Number(process.env.ARENA_BOT_IMPORT_PACE_MS ?? '250');

/**
 * Retry a node call through rate limiting.
 *
 * The public testnet RPC answers 429 under load, and a 429 is not a failure —
 * it is "ask again". Treating it as one left the bot with 88 of 200 cards
 * imported and no way to tell that from a real error. Only retries rate limits
 * and transient transport errors; anything else fails immediately, because
 * retrying a genuine error just delays the report.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  log: (m: string) => void,
  attempts = Number(process.env.ARENA_BOT_RETRY_ATTEMPTS ?? '9'),
  initialDelay = 1000,
): Promise<T> {
  let delay = initialDelay;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = /429|rate limit|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(msg);
      if (!transient || i >= attempts - 1) throw err;
      log(`rate-limited, retrying in ${delay}ms (${i + 1}/${attempts - 1})`);
      await new Promise(r => setTimeout(r, delay));
      // Cap high: a saturated public RPC stays saturated for tens of seconds,
      // and giving up early loses a whole match rather than waiting one out.
      delay = Math.min(Math.max(delay * 2, 1), 60_000);
    }
  }
}

/**
 * Wrap the ops layer so every chain call survives rate limiting.
 *
 * The public testnet RPC answers 429 under ordinary load — enough to kill a
 * `create_game` outright and lose the whole match. A 429 is the protocol saying
 * "ask again"; treating it as a failure is not caution, it is a bot that cannot
 * play on the network it is deployed to.
 *
 * Retrying a SEND is safe here even if the original reached the node: the retry
 * spends the same notes, so a landed original makes the duplicate fail as an
 * existing nullifier rather than committing anything twice. Only rate limits and
 * transport errors retry; a revert or an assertion fails immediately, because
 * retrying a genuine error only delays the report.
 *
 * Applied at this boundary rather than inside the shared pxe.ts, because that
 * module is the browser's proving path too and a change there needs its own
 * verification.
 */
function withRateLimitRetries<T extends object>(ops: T, log: (m: string) => void): T {
  return new Proxy(ops, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        withRetry(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), log);
    },
  }) as T;
}

/** Process-wide guard: see the one-identity-per-process note above. */
let connectedIdentity: string | null = null;

export class BotChain {
  private wallet: unknown = null;
  private node: any = null;
  private identity: BotIdentity | null = null;
  private ops: any = null;

  constructor(private readonly cfg: BotChainConfig, private readonly log: Logger = () => {}) {}

  get address(): string {
    if (!this.identity) throw new Error('BotChain not connected');
    return this.identity.address;
  }

  /**
   * The node client. Send options MUST carry it: pxe.ts estimates a fee headroom
   * via node.getCurrentMinFees(), and omitting it fails the send with
   * "Cannot read properties of undefined (reading 'getCurrentMinFees')".
   */
  get nodeClient(): any {
    if (!this.node) throw new Error('BotChain not connected');
    return this.node;
  }

  get cards(): number[] {
    return this.identity?.cardIds ?? [];
  }

  /**
   * Bootstrap: artifact sources → wallet → contracts → ops binding.
   *
   * Verifies the manifest's chain stamp against the live node. The testnet
   * re-genesises on upgrades, orphaning the bot's account and cards exactly as
   * it does the playtest pool — a bot silently playing against a chain its
   * identity does not exist on would fail at commit time, per game, forever.
   */
  async connect(): Promise<void> {
    this.identity = loadBotIdentity(this.cfg.manifestPath);
    await installNodeArtifactSources({
      circuitsDir: this.cfg.circuitsDir,
      contractsDir: this.cfg.contractsDir,
    });

    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
    const { Fr } = await import('@aztec/aztec.js/fields');
    const { GrumpkinScalar } = await import('@aztec/foundation/curves/grumpkin');

    this.node = createAztecNodeClient(this.cfg.pxeUrl);
    const { rollupVersion } = await this.node.getNodeInfo();
    if (Number(rollupVersion) !== this.identity.rollupVersion) {
      throw new Error(
        `Arena bot identity is for rollupVersion ${this.identity.rollupVersion} but the node reports ` +
        `${Number(rollupVersion)} — the chain re-genesised and the bot's account and cards are orphaned. ` +
        `Re-provision: npx tsx scripts/provision-arena-bot.ts`,
      );
    }

    const wallet = await EmbeddedWallet.create(this.node, {
      ephemeral: false,
      // Per-identity, NOT the default shared directory — see dataDir.ts. Must
      // match what provision-arena-bot.ts used for this index, since that is
      // the store its cards were minted into.
      pxeConfig: {
        proverEnabled: true,
        // Version-scoped: a store from a dead chain fails with "unknown note
        // hash", which looks nothing like the stale directory it is.
        dataDirectory: identityDataDirectory(this.identity.index, process.cwd(), Number(rollupVersion)),
      },
    });
    const account = await wallet.createSchnorrAccount(
      Fr.fromHexString(this.identity.secret),
      Fr.fromHexString(this.identity.salt),
      GrumpkinScalar.fromHexString(this.identity.signingKey),
    );
    if (account.address.toString() !== this.identity.address) {
      throw new Error(
        `Derived bot address ${account.address.toString()} does not match the manifest ` +
        `${this.identity.address} — the seed or keys changed since provisioning.`,
      );
    }
    this.wallet = wallet;

    const { registerGameContracts } = await import('../../frontend/src/aztec/contractArtifacts.js');
    await registerGameContracts(wallet, this.node, {
      nft: this.cfg.nftAddress,
      game: this.cfg.gameAddress,
      token: this.cfg.tokenAddress,
    }, this.log);

    if (connectedIdentity && connectedIdentity !== this.identity.address) {
      throw new Error(
        `A BotChain for ${connectedIdentity} is already connected in this process. pxe.ts binds ` +
        `the wallet globally, so a second identity would silently rebind BOTH to the newer wallet. ` +
        `Run one identity per process.`,
      );
    }
    const { setPxeWallet, pxe } = await import('../../frontend/src/aztec/pxe.js');
    setPxeWallet(wallet);
    connectedIdentity = this.identity.address;
    this.ops = withRateLimitRetries(pxe, m => this.log(m));
    await this.importStock();
    this.log(`chain ready as ${this.identity.address.slice(0, 20)}… (${(await this.readCards()).length} spendable)`);
  }

  /**
   * Import the notes the provisioner minted for this identity.
   *
   * The bot's stock is minted UNTAGGED (create_and_push_note), because the
   * tagged path caps at ~84 notes per finalisation window and a deep stock blows
   * straight through it. Untagged notes are invisible to the PXE until imported,
   * so without this the cards exist on-chain and the bot cannot spend a single
   * one of them.
   *
   * Idempotent and incremental: already-imported notes are recorded next to the
   * manifest, so a restart re-imports nothing. import_note itself tolerates a
   * repeat, but a thousand redundant simulate calls on every boot would not be
   * tolerable.
   */
  private async importStock(): Promise<void> {
    // Dedupe by note identity: a manifest can carry the same note twice (a
    // retried batch, an older writer), and importing a duplicate is wasted work
    // on a rate-limited node rather than an error.
    const seenNote = new Set<string>();
    const notes = (this.identity?.notes ?? []).filter(n => {
      const k = `${n.tokenId}:${n.randomness}`;
      if (seenNote.has(k)) return false;
      seenNote.add(k);
      return true;
    });
    if (notes.length === 0) return;

    const markerPath = `${this.cfg.manifestPath}.imported.json`;
    let done = new Set<string>(
      existsSync(markerPath) ? (JSON.parse(readFileSync(markerPath, 'utf-8')) as string[]) : [],
    );

    // The marker records what THIS store imported, and a store can be wiped
    // (a fresh machine, a cleared data directory, a re-provision) while the
    // marker file survives beside the manifest. It then claims everything is
    // imported into a PXE that holds nothing, and the bot idles for want of
    // cards it demonstrably owns. Holding zero while the manifest lists notes
    // is unambiguous: re-import. import_note is idempotent, so the cost of
    // being wrong here is time, and the cost of NOT checking is a bot that
    // never plays again.
    if (done.size > 0 && (await this.readCards()).length === 0) {
      this.log('holding 0 cards but the import marker says otherwise — the PXE store was wiped; re-importing');
      done = new Set<string>();
    }

    const key = (n: { tokenId: number; randomness: string }) => `${n.tokenId}:${n.randomness}`;
    const pending = notes.filter(n => !done.has(key(n)));
    if (pending.length === 0) return;

    this.log(`importing ${pending.length} card note(s) — untagged mints are invisible until imported`);
    const { fetchTxEffectData } = await import('../../frontend/src/aztec/noteImporter.js');

    // Group by tx: the TxEffect (note hashes + first nullifier) is one node read
    // per transaction, not per note.
    const byTx = new Map<string, typeof pending>();
    for (const n of pending) byTx.set(n.txHash, [...(byTx.get(n.txHash) ?? []), n]);

    let imported = 0;
    let failed = 0;
    for (const [txHash, group] of byTx) {
      try {
        const effect = await withRetry(
          () => fetchTxEffectData(this.node, txHash),
          m => this.log(m),
        );
        if (!effect) {
          this.log(`WARNING: no TxEffect for ${txHash.slice(0, 18)}… — ${group.length} note(s) not imported`);
          failed += group.length;
          continue;
        }
        await withRetry(
          () => this.pxe.importCardNotes(
            this.address, txHash,
            group.map(n => ({ tokenId: n.tokenId, randomness: n.randomness })),
            'bot stock', effect,
          ),
          m => this.log(m),
        );
        for (const n of group) { done.add(key(n)); imported += 1; }
        // Persist as we go: a run interrupted at note 900 must not start over.
        writeFileSync(markerPath, JSON.stringify([...done]));
      } catch (err) {
        // Not fatal: the rest of the stock may still import, and a later start
        // retries this tx. Loud, because an unimported note is a card the bot
        // owns and cannot play.
        failed += group.length;
        this.log(`WARNING: import of tx ${txHash.slice(0, 18)}… failed: ${(err as Error).message}`);
      }
      // Pace against the public testnet RPC, which rate-limits (HTTP 429) long
      // before it runs out of capacity. Importing a deep stock is the single
      // burstiest thing the bot ever does.
      await new Promise(r => setTimeout(r, IMPORT_PACE_MS));
    }
    writeFileSync(markerPath, JSON.stringify([...done]));
    this.log(`imported ${imported} card note(s)${failed ? `, ${failed} still pending (retried next start)` : ''}`);
  }

  /** The frontend's ops layer, bound to the bot's wallet. */
  get pxe(): any {
    if (!this.ops) throw new Error('BotChain not connected — call connect() first');
    return this.ops;
  }

  /** Cards the bot's PXE can actually spend right now. */
  /**
   * The collection, cached.
   *
   * readPrivateCards pages the whole collection ten cards at a time, so it is
   * O(cards) sequential simulations against the node — about 46 seconds at
   * 1,382 cards. The bot polls every two seconds and used to re-read on every
   * poll, which enqueued a 46-second operation 23 times faster than the single
   * serial PXE queue could drain it. A join then waited behind 21 of them:
   * sixteen minutes, measured in production, for a transaction that takes
   * forty-four seconds.
   *
   * The count only changes when cards move — a commit, a settlement, an import
   * — and those all invalidate explicitly. The TTL is a backstop for anything
   * that changes them without saying so.
   */
  private cardCache: { ids: number[]; at: number } | null = null;
  private cardRead: Promise<number[]> | null = null;
  private static readonly CARD_CACHE_TTL_MS = 120_000;

  async readCards(opts: { force?: boolean } = {}): Promise<number[]> {
    const fresh = this.cardCache
      && Date.now() - this.cardCache.at < BotChain.CARD_CACHE_TTL_MS;
    if (!opts.force && fresh) return this.cardCache!.ids;

    // Share the in-flight read. Caching only the RESULT is not enough: the read
    // takes ~46 seconds and the bot polls every two, so twenty-three callers
    // start before the first finishes, every one of them misses an empty cache,
    // and every one enqueues its own page-through. That stampede is what
    // actually filled the queue — the first version of this cache changed
    // nothing because the queue was already full of reads that had all begun.
    if (!opts.force && this.cardRead) return this.cardRead;

    const read = (async () => {
      const ids = await this.pxe.readPrivateCards(this.address);
      this.cardCache = { ids, at: Date.now() };
      this.lastKnownCardCount = ids.length;
      return ids;
    })();
    this.cardRead = read;
    try {
      return await read;
    } finally {
      if (this.cardRead === read) this.cardRead = null;
    }
  }

  /** Call whenever cards move; the next read pays for a fresh page-through. */
  invalidateCards(): void {
    this.cardCache = null;
  }

  /** True while a page-through is in flight; exposed for tests. */
  get cardReadInFlight(): boolean {
    return this.cardRead !== null;
  }

  /**
   * Pick five cards to wager.
   *
   * DISTINCT types, not simply the lowest five ids. The bot's stock is
   * deliberately duplicated — many copies of a few weak types — so "sort and
   * take five" would hand it five copies of the same card every single game:
   * legal, but a fixed and trivially readable hand. Rotating through the types
   * it holds costs nothing and keeps games varied.
   *
   * Falls back to duplicates only if it genuinely holds fewer than five types,
   * because a duplicated hand still plays; refusing would idle the bot over a
   * cosmetic preference.
   */
  /**
   * Cards held at the last selectHand. Surfaced on /health because it is the
   * number that predicts the bot going idle — and an idle bot is
   * indistinguishable from a quiet night until someone notices the arena has no
   * opponent. Read from a cached value rather than a fresh chain call so a
   * health probe cannot add load to a rate-limited node.
   */
  lastKnownCardCount = -1;

  /**
   * Fee Juice at the last check, or -1 if never read.
   *
   * The bot pays its own fees for every commit and every settlement, and
   * running dry is not graceful: it still queues, matches and plays a full
   * nine-move game, then cannot settle it — locking five of its cards and
   * handing the player a match that never resolves. Cached like the card
   * count so a health probe adds no load to a rate-limited node.
   */
  lastKnownFeeJuice = -1n;

  /** Read the account's Fee Juice balance from public state. */
  async readFeeJuice(): Promise<bigint> {
    const [{ Fr }, { ProtocolContractAddress }, { deriveStorageSlotInMap }] = await Promise.all([
      import('@aztec/foundation/curves/bn254'),
      import('@aztec/protocol-contracts'),
      import('@aztec/stdlib/hash'),
    ]);
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    // Slot 1 is FeeJuice's balances map — the derivation the SDK's own
    // getFeeJuiceBalance uses, rather than a slot read off a layout dump.
    const slot = await deriveStorageSlotInMap(new Fr(1), AztecAddress.fromStringUnsafe(this.address));
    const raw = await this.node.getPublicStorageAt('latest', ProtocolContractAddress.FeeJuice, slot);
    this.lastKnownFeeJuice = raw.toBigInt();
    return this.lastKnownFeeJuice;
  }

  async selectHand(size = 5): Promise<number[]> {
    const held = await this.readCards();
    this.lastKnownCardCount = held.length;
    if (held.length < size) {
      throw new Error(
        `Arena bot holds only ${held.length} card(s) but needs ${size}. Its collection is a LOSS ` +
        `BUDGET — every player who beats it takes one. Re-provision or lower the game rate.`,
      );
    }

    // Round-robin across the stacks the bot holds, one copy at a time. This
    // maximises distinct types AND can never name more copies of an id than are
    // actually held — a hand naming a card it does not have fails on-chain with
    // "Could not find all 5 cards", which is precisely the failure this whole
    // area has already cost us once.
    const stacks = new Map<number, number>();
    for (const id of held) stacks.set(id, (stacks.get(id) ?? 0) + 1);
    const ids = [...stacks.keys()].sort((a, b) => (stacks.get(b)! - stacks.get(a)!) || a - b);

    const hand: number[] = [];
    while (hand.length < size) {
      let tookOne = false;
      for (const id of ids) {
        if (hand.length === size) break;
        const left = stacks.get(id)!;
        if (left > 0) {
          hand.push(id);
          stacks.set(id, left - 1);
          tookOne = true;
        }
      }
      // Unreachable given the length check above, but a stock that cannot fill
      // a hand must not spin forever.
      if (!tookOne) break;
    }
    const picked = hand.slice(0, size);

    // A DUPLICATED hand cannot be proved, and by then the cards are gone.
    //
    // The round-robin above takes a second copy of a type once it runs out of
    // types, so a stock of fewer than `size` distinct types yields something
    // like [A,B,A,B,A]. prove_hand asserts `card_ids[i] != card_ids[j]` and
    // rejects exactly that — while join_game has ALREADY committed the cards,
    // because the commit precedes our own hand proof. No hand proof means the
    // sweep classifies the game "missing a hand proof — unrecoverable", which
    // is permanent: five cards destroyed.
    //
    // Worse, it is a spiral. The fallback fires precisely when types are
    // scarce, and each occurrence burns five more cards, narrowing the stock
    // further. An earlier comment here reasoned that "a duplicated hand still
    // plays"; it does not, and the circuit has always said so.
    //
    // Refusing to play is strictly better. The bot idles and the arena has no
    // opponent, which is visible and repairable; the alternative is silent,
    // permanent loss.
    if (new Set(picked).size !== picked.length) {
      const types = new Set(held).size;
      throw new Error(
        `Arena bot holds ${held.length} card(s) but only ${types} distinct type(s), so a hand of ` +
        `${size} would repeat one. prove_hand rejects duplicate card ids, and join_game commits ` +
        `BEFORE that proof — playing this hand would strand five cards unrecoverably. ` +
        `Re-provision with more card types.`,
      );
    }
    return picked;
  }
}


/** Exported for tests only — the retry policy is worth asserting directly. */
export const withRetryForTests = withRetry;
