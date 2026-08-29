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
import { readFileSync, existsSync } from 'fs';
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
}

export interface BotChainConfig {
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
      pxeConfig: { proverEnabled: true, dataDirectory: identityDataDirectory(this.identity.index) },
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
    this.ops = pxe;
    this.log(`chain ready as ${this.identity.address.slice(0, 20)}… (${this.identity.cardIds.length} cards)`);
  }

  /** The frontend's ops layer, bound to the bot's wallet. */
  get pxe(): any {
    if (!this.ops) throw new Error('BotChain not connected — call connect() first');
    return this.ops;
  }

  /** Cards the bot's PXE can actually spend right now. */
  async readCards(): Promise<number[]> {
    return await this.pxe.readPrivateCards(this.address);
  }

  /**
   * Pick five cards to wager. Lowest ids first, purely so a game is
   * reproducible from the logs; strategy belongs in chooseBotMove, not here.
   * Throws rather than committing a short hand — that would fail on-chain.
   */
  async selectHand(size = 5): Promise<number[]> {
    const held = await this.readCards();
    if (held.length < size) {
      throw new Error(
        `Arena bot holds only ${held.length} card(s) but needs ${size}. Its collection is a LOSS ` +
        `BUDGET — every player who beats it takes one. Re-provision or lower the game rate.`,
      );
    }
    return [...held].sort((a, b) => a - b).slice(0, size);
  }
}
