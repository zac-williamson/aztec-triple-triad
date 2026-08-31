#!/usr/bin/env npx tsx
/**
 * Provision an arena-bot identity: deploy its account and mint it a card
 * collection.
 *
 * NO CONTRACT CHANGE IS NEEDED for this, contrary to the original plan. The NFT
 * contract's `mint_to_private(to, token_id, packed_ranks)` is gated on `minter`
 * (a PublicImmutable set at construction to the deployer, whose key we hold) and
 * delivers `onchain_constrained()`, so the recipient's PXE discovers the notes
 * normally — no import_note dance, unlike `get_cards_for_new_player`. Reading a
 * big collection is already paginated via `get_nfts_for_user(owner, page_index)`.
 * See docs/plan/BACKEND_OPPONENT.md §2a.
 *
 * Cost is one tx per card, which is a ONE-TIME setup, not a per-game cost.
 *
 * The collection is the bot's LOSS BUDGET, not just a concurrency budget:
 * settlement transfers a card from loser to winner, so every player who beats
 * the bot permanently takes one. Size it accordingly and watch the
 * botCardNetFlow metric. This script deliberately does NOT re-mint on demand —
 * an auto-refilling bot is an unbounded card faucet and that is hard to walk
 * back once players have farmed it.
 *
 * Usage:
 *   export AZTEC_PXE_URL=http://localhost:8080          # sandbox, or testnet RPC
 *   export TESTNET_L1_RPC_URL=https://...sepolia...     # only if bridging
 *   export TREASURY_L1_KEY_FILE=~/.aztec-triad-private/treasury-l1-key.txt
 *   export DEPLOYER_SECRET=0x... DEPLOYER_SALT=0x... DEPLOYER_SIGNING_KEY=0x...
 *   npx tsx scripts/provision-arena-bot.ts --cards 40
 *   npx tsx scripts/provision-arena-bot.ts --index 1 --cards 40   # pool member 1
 *   npx tsx scripts/provision-arena-bot.ts --dry-run              # derive + report only
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { NO_FROM } from '@aztec/aztec.js/account';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

import {
  bridgeFeeJuice, serializeClaim, deserializeClaim, getStoredClaim, loadClaimStore,
  putStoredClaim, markClaimConsumed, claimStorePath, readFunderKey, type FeeJuiceClaim,
} from './lib/feeJuiceBridge';
import { headroomMaxFeesPerGas } from './lib/feeSettings';
import { arenaBotAccount, ARENA_BOT_SEED as ARENA_BOT_SEED_LABEL } from './lib/arenaBotAccount';
import { CARD_DATABASE, packRanks } from '../packages/game-logic/src/cards';

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
/**
 * Where contract addresses come from when the environment does not carry them.
 *
 * Defaults to the sandbox file, which is fine for a sandbox and was silently
 * wrong for everything else: this script was minting against whatever `.env`
 * said no matter which network AZTEC_PXE_URL pointed at. Pointing it at testnet
 * therefore tried to mint into a sandbox contract address, and the only reason
 * it did not do something worse is that the address does not exist there.
 *
 * `process.env` now wins, so the usual `set -a; . packages/frontend/.env.testnet`
 * does what it obviously looks like it does. ARENA_ENV_FILE overrides the file.
 */
const ENV_PATH = resolve(ROOT_DIR, process.env.ARENA_ENV_FILE ?? 'packages/frontend/.env');
/**
 * One manifest PER IDENTITY. A single shared file would let provisioning index 1
 * silently overwrite index 0's keys and card list, which is precisely the pool
 * the plan calls for (docs/plan/BACKEND_OPPONENT.md §2b) failing silently.
 */
/**
 * Where identity manifests live.
 *
 * Overridable so a sandbox and a testnet set can coexist. They must NOT share a
 * directory: the manifest is the ONLY record of an untagged note's plaintext, so
 * anything that moves, swaps or overwrites it orphans real on-chain cards. That
 * is not hypothetical — swapping this directory between a sandbox run and a
 * concurrent testnet mint cost 800 notes, permanently unimportable.
 */
const ARTIFACTS_DIR = process.env.ARENA_BOT_ARTIFACTS_DIR
  ? resolve(process.env.ARENA_BOT_ARTIFACTS_DIR)
  : resolve(ROOT_DIR, 'packages/bot/.artifacts');
const manifestPath = (index: number) =>
  resolve(ARTIFACTS_DIR, `arena-bot-${index}.json`);
const TX_TIMEOUT = 600;
/** A wagered hand. The bot must always be able to field one. */
const HAND_SIZE = 5;

interface BotManifest {
  index: number;
  address: string;
  secret: string;
  salt: string;
  signingKey: string;
  /** Card ids minted to this identity, in mint order. */
  cardIds: number[];
  /**
   * The note plaintexts the bot must IMPORT to see its cards.
   *
   * mint_bot_cards creates untagged notes (create_and_push_note), which the
   * PXE cannot discover passively — the tagged path caps at ~84 notes per
   * finalisation window, which a deep stock blows straight through. So the
   * randomness lives here, and BotChain imports from it on connect. Without
   * this the cards exist on-chain and the bot cannot see or spend one of them.
   */
  notes?: { tokenId: number; randomness: string; txHash: string }[];
  /** Chain this identity exists on — a re-genesis orphans it, exactly as it
   *  does the playtest pool, so the stamp is what makes staleness detectable. */
  rollupVersion: number;
  provisionedAt: string;
  updatedAt?: string;
}

const arg = (name: string, dflt: number, allowZero = false): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const n = Number(process.argv[i + 1]);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} needs an integer >= ${min}`);
  }
  return n;
};

function readEnvAddress(key: string): string {
  // The environment wins: minting is network-specific, and the address must be
  // able to follow AZTEC_PXE_URL rather than being pinned to one file.
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} missing — deploy the contracts first`);
  const m = readFileSync(ENV_PATH, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} missing from ${ENV_PATH} (and not in the environment)`);
  return m[1].trim();
}

/**
 * How many distinct card TYPES the bot's stock is drawn from.
 *
 * Not one: a bot holding a thousand copies of a single card plays the same hand
 * every game and is trivially readable. Not many either — the bot should be
 * beatable, and its collection is what players win off it.
 */
const BOT_CARD_TYPES = 12;

/**
 * The bot's stock: `count` cards drawn from the WEAKEST types in the database.
 *
 * Two deliberate choices.
 *
 * **Weak.** Every player who beats the bot permanently takes one of these, so
 * the collection is a payout schedule as much as a wager. Weak cards keep that
 * payout modest and keep the bot beatable, which is the point of having it.
 *
 * **Duplicated.** `mint_bot_cards` lets the bot — and only the bot — hold many
 * cards of one token_id, so its stock is no longer capped by the size of the
 * card database and no longer competes with players for ids. Which INSTANCE the
 * bot holds is meaningless; how many it has is not.
 */
function collectionFor(count: number): { id: number; packed: string }[] {
  const weakest = [...CARD_DATABASE]
    .sort((a, b) =>
      (a.ranks.top + a.ranks.right + a.ranks.bottom + a.ranks.left) -
      (b.ranks.top + b.ranks.right + b.ranks.bottom + b.ranks.left))
    .slice(0, BOT_CARD_TYPES);

  // packRanks takes the four ranks POSITIONALLY, not the ranks object — passing
  // the object produced "[object Object]NaNNaNNaN" and a BigInt conversion error
  // at mint time rather than a type error, because the packing is arithmetic.
  return Array.from({ length: count }, (_, i) => {
    const c = weakest[i % weakest.length];
    return {
      id: c.id,
      packed: packRanks(c.ranks.top, c.ranks.right, c.ranks.bottom, c.ranks.left).toString(),
    };
  });
}

/**
 * Read an owner's full private card collection through `get_nfts_for_user`,
 * page by page. Simulate returns `{ result: [page, hasMore] }` — the tuple is
 * nested under `result`, not the top-level value.
 */
async function readCollection(nft: any, owner: any): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 0; ; page++) {
    const { result } = await nft.methods.get_nfts_for_user(owner, page).simulate({ from: owner });
    for (const val of (result[0] ?? [])) {
      const id = Number(BigInt(val));
      if (id !== 0) ids.push(id);
    }
    if (result[1] !== true) break;
    if (page > 500) throw new Error('get_nfts_for_user pagination did not terminate');
  }
  return ids;
}

async function obtainClaim(node: any, address: string, l1ChainId: number): Promise<FeeJuiceClaim> {
  // Local sandbox funds from the well-known anvil account, not the Sepolia
  // treasury, and needs the mineBlock nudge (v5's automine sequencer builds a
  // block only on tx activity, so a freshly-bridged L1->L2 message would have
  // no block to land in). fundDevnet.ts already encapsulates both.
  if (l1ChainId === 31337) {
    console.log('  local sandbox — bridging Fee Juice from the anvil funder...');
    const { fundAccountOnDevnet } = await import('../packages/frontend/src/aztec/fundDevnet');
    return await fundAccountOnDevnet(node, address, (m: string) => console.log(`    ${m}`)) as FeeJuiceClaim;
  }

  const storePath = claimStorePath();
  const stored = getStoredClaim(loadClaimStore(storePath), address);
  if (stored && stored.status === 'pending') {
    console.log(`  reusing persisted pending claim (${stored.claimAmount})`);
    return deserializeClaim(stored, Fr);
  }
  const l1RpcUrl = process.env.TESTNET_L1_RPC_URL;
  if (!l1RpcUrl || !(process.env.TREASURY_L1_KEY || process.env.TREASURY_L1_KEY_FILE)) {
    throw new Error(
      `No Fee Juice claim for the bot (${address}) and no treasury creds to bridge one.\n` +
      `  Set TESTNET_L1_RPC_URL + TREASURY_L1_KEY (or _FILE).`,
    );
  }
  console.log('  bridging Fee Juice for the bot...');
  const claim = await bridgeFeeJuice({
    node, l1RpcUrl, funderKey: readFunderKey(), l2Address: address,
    log: (m: string) => console.log(`    ${m}`),
    messageWaitSeconds: process.env.MESSAGE_WAIT_SECONDS ? Number(process.env.MESSAGE_WAIT_SECONDS) : 600,
  });
  putStoredClaim(storePath, address, serializeClaim(address, claim, new Date().toISOString()));
  return claim;
}

/**
 * How many cards this identity has been minted in total, from its manifest.
 * With duplicates the manifest is a MULTISET, so length is the count that
 * matters — not the number of distinct ids.
 */
function previousMintedTotal(index: number): number {
  const p = manifestPath(index);
  if (!existsSync(p)) return 0;
  return ((JSON.parse(readFileSync(p, 'utf-8')) as BotManifest).cardIds ?? []).length;
}

/**
 * Write the manifest, merging with whatever is already recorded.
 *
 * Called after EVERY mint batch: the manifest is the sole record of an untagged
 * note's plaintext, and a note whose randomness is lost is a card nobody can
 * ever import or spend.
 */
function persistNotes(
  index: number,
  address: string,
  keys: { secret: string; salt: string; signingKey: string },
  rollupVersion: number,
  notes: { tokenId: number; randomness: string; txHash: string }[],
  cardIds: number[],
): void {
  const p = manifestPath(index);
  const prior: Partial<BotManifest> = existsSync(p)
    ? JSON.parse(readFileSync(p, 'utf-8'))
    : {};
  // Dedupe across BOTH inputs, not just against what is already on disk. This
  // function is called once per batch with the whole accumulated list, so any
  // overlap — a retried batch, a re-run, a partially written manifest — would
  // otherwise double entries. Observed: 1800 records for 1000 notes, which
  // doubles every import at boot for no benefit. (tokenId, randomness) is the
  // note's identity; the tx it came from is not part of it.
  const seen = new Set<string>();
  const merged: NonNullable<BotManifest['notes']> = [];
  for (const n of [...(prior.notes ?? []), ...notes]) {
    const k = `${n.tokenId}:${n.randomness}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(n);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    ...prior, index, address, ...keys,
    cardIds, notes: merged, rollupVersion,
    provisionedAt: prior.provisionedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

async function main(): Promise<number> {
  const index = arg('index', 0, true);   // 0 is the default identity
  const cardCount = arg('cards', 40);
  const dryRun = process.argv.includes('--dry-run');

  const keys = arenaBotAccount(index);
  // No --offset any more. Identities no longer need disjoint id slices: the bot
  // mints DUPLICATES, so every identity draws from the same small set of weak
  // card types and none of them compete with players for ids.
  const collection = collectionFor(cardCount);
  const distinct = new Set(collection.map(c => c.id));

  console.log('=== Arena bot provisioning ===');
  console.log(`  PXE:    ${PXE_URL}`);
  console.log(`  Index:  ${index} (arena bot slot ${index})`);
  console.log(`  Cards:  ${cardCount} across ${distinct.size} weak type(s): ${[...distinct].join(',')}`);

  // --dry-run must not need a chain: it exists to check the derivation and the
  // collection plan before anyone spends gas.
  if (dryRun) {
    console.log(`  Keys:   secret/salt/signing derived from '${ARENA_BOT_SEED_LABEL}' index ${index}`);
    console.log('\n--dry-run: derived only. No node contacted, nothing deployed or minted.');
    return 0;
  }

  const node = createAztecNodeClient(PXE_URL);
  const { rollupVersion, l1ChainId } = await node.getNodeInfo();
  console.log(`  Chain:  rollupVersion ${Number(rollupVersion)} l1ChainId ${Number(l1ChainId)}`);

  // Per-identity store, matching what BotChain opens for this index — the bot
  // spends exactly the notes minted here. Sharing one directory across
  // identities wedges LMDB the moment two of them run at once; see
  // packages/bot/src/dataDir.ts.
  const { identityDataDirectory } = await import('../packages/bot/src/dataDir.js');
  const dataDirectory = identityDataDirectory(index, ROOT_DIR, Number(rollupVersion));
  console.log(`  Store:  ${dataDirectory}`);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxeConfig: { proverEnabled: true, dataDirectory },
  });
  const botAccount = await wallet.createSchnorrAccount(
    Fr.fromHexString(keys.secret),
    Fr.fromHexString(keys.salt),
    GrumpkinScalar.fromHexString(keys.signingKey),
  );
  const botAddress = botAccount.address.toString();
  console.log(`  Bot:    ${botAddress}`);

  const nftAddress = readEnvAddress('VITE_NFT_CONTRACT_ADDRESS');
  const tokenAddress = readEnvAddress('VITE_TOKEN_CONTRACT_ADDRESS');

  // 1. Deploy the bot account, paying with its bridged claim in-tx.
  const claim = await obtainClaim(node, botAddress, Number(l1ChainId));
  console.log('  deploying bot account (claim paid in-tx)...');
  try {
    const deployMethod = await botAccount.getDeployMethod();
    await deployMethod.send({
      from: NO_FROM,
      fee: {
        paymentMethod: new FeeJuicePaymentMethodWithClaim(botAccount.address, claim),
        gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) },
      },
      wait: { timeout: TX_TIMEOUT },
    });
    if (Number(l1ChainId) !== 31337) markClaimConsumed(claimStorePath(), botAddress);
    console.log('  account deployed; claim consumed');
  } catch (err: any) {
    const msg = String(err?.cause?.message ?? err?.message ?? err);
    if (/Existing nullifier|Nullifier conflict/i.test(msg)) {
      console.log('  account already deployed — continuing to mint');
    } else {
      throw err;
    }
  }

  // 2. Resolve the minter (the deployer) and the NFT contract. Only the minter
  //    can mint; the bot pays for its own starter claim.
  //    Serial: all PXE operations are serial per wallet (CLAUDE.md ground rule 6).
  const deployerSecret = process.env.DEPLOYER_SECRET;
  const deployerSalt = process.env.DEPLOYER_SALT;
  const deployerSigning = process.env.DEPLOYER_SIGNING_KEY;
  if (!deployerSecret || !deployerSalt || !deployerSigning) {
    throw new Error('DEPLOYER_SECRET/SALT/SIGNING_KEY are required — only the minter can mint');
  }
  const deployer = await wallet.createSchnorrAccount(
    Fr.fromHexString(deployerSecret),
    Fr.fromHexString(deployerSalt),
    GrumpkinScalar.fromHexString(deployerSigning),
  );

  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const { Contract } = await import('@aztec/aztec.js/contracts');
  const nftArtifact = loadContractArtifact(
    JSON.parse(readFileSync(resolve(ROOT_DIR, 'packages/contracts/target/triple_triad_nft-TripleTriadNFT.json'), 'utf-8')),
  );
  // Contract.at alone does NOT register the class with the wallet — sends then
  // fail "No artifact registered for contract class". Fetch the on-chain
  // instance and register it first, exactly as provision-playtest-accounts does.
  const nftAddr = AztecAddress.fromStringUnsafe(nftAddress);
  const nftInstance = await node.getContract(nftAddr);
  if (!nftInstance) throw new Error(`NFT contract ${nftAddress} not found on this chain`);
  await wallet.registerContract(nftInstance, nftArtifact);
  await wallet.registerSender(nftAddr, 'nft');
  const nft = await Contract.at(nftAddr, nftArtifact, wallet as never);

  // ArenaToken too, and not for symmetry: get_cards_for_new_player calls
  // ArenaToken.mint_private (the signup reward), so a PXE that does not know
  // the token instance fails the starter claim with
  // "No contract instance found for address 0x…" — from inside a call the
  // script never makes directly, which makes it read like an NFT bug.
  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(resolve(ROOT_DIR, 'packages/contracts/target/arena_token-ArenaToken.json'), 'utf-8')),
  );
  const tokenAddr = AztecAddress.fromStringUnsafe(tokenAddress);
  const tokenInstance = await node.getContract(tokenAddr);
  if (!tokenInstance) throw new Error(`ArenaToken ${tokenAddress} not found on this chain`);
  await wallet.registerContract(tokenInstance, tokenArtifact);
  await wallet.registerSender(tokenAddr, 'token');

  // 3. Claim starter cards AS THE BOT — this is what initialises its
  //    `note_nonce`. Without it every create_game/join_game fails
  //    "Note nonce not found": the nonce is pushed by get_cards_for_new_player
  //    (main.nr:437), the real onboarding path, and mint_to_private does not
  //    touch it. Claiming is one-per-account (nullifier-gated), so a re-run is
  //    a no-op rather than an abuse.
  //
  //    Its 5 starter cards arrive via create_and_push_note and are NOT
  //    auto-discovered, so they stay invisible to the bot's PXE unless imported.
  //    That is fine and self-consistent: the bot's SPENDABLE collection is the
  //    explicitly minted set, and selectHand() reads what the PXE can actually
  //    see. Those ids also cost nothing from the global budget, since
  //    create_and_push_note never touches nft_exists.
  try {
    await nft.methods.get_cards_for_new_player().send({
      from: botAccount.address,
      fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
      wait: { timeout: TX_TIMEOUT },
    });
    console.log('  starter claim done — note_nonce initialised');
  } catch (err: any) {
    const msg = String(err?.cause?.message ?? err?.message ?? err);
    if (/nullifier|already|claimed/i.test(msg)) {
      console.log('  starter already claimed — note_nonce present');
    } else {
      throw err;
    }
  }


  // Top up to the requested SIZE, rather than minting ids that are missing.
  // With duplicates the identity of a card carries no information — ten copies
  // of card 3 are ten cards — so the only meaningful question is how many the
  // bot can field. Cards committed to an unsettled game are nullified out of the
  // PXE and reappear on settlement, so count them as present: minting to cover
  // them would inflate the stock every time a game is in flight.
  const heldNow = await readCollection(nft, botAccount.address);
  const committedElsewhere = Math.max(0, (previousMintedTotal(index)) - heldNow.length);
  // `heldNow` is what THIS script's PXE can see, which is not what the bot can
  // see and never will be: mint_bot_cards creates untagged notes, and this
  // process never imports them. After minting 800 cards its own view still read
  // 144. So the manifest — every note this identity has ever been minted — is
  // the only sound basis for "how many does it have", and cards committed to a
  // live game count as present because they return on settlement.
  //
  // A `--spendable` flag that targeted `heldNow` instead lived here briefly and
  // over-minted by 456 cards on its first run, for exactly this reason. What
  // the bot can actually FIELD is knowable only inside the bot; ask its
  // /health endpoint, not this script.
  const have = Math.max(heldNow.length + committedElsewhere, previousMintedTotal(index));
  const toMint = Math.max(0, cardCount - have);
  console.log(
    `  holding ${heldNow.length} visible here` +
    (committedElsewhere > 0 ? ` + ${committedElsewhere} minted but not visible to this process` : '') +
    ` — minting ${toMint} more to reach ${cardCount} minted`,
  );

  // 4. Mint in batches. One tx per batch rather than per card: at a thousand
  //    cards that is the difference between ~125 transactions and 1000.
  //
  //    EIGHT, not the contract's full array width of 10. Ten inserts in one
  //    private call overflows a protocol bounded vec — "push out of bounds" —
  //    despite MAX_NOTE_HASHES_PER_CALL being 16, because each constrained
  //    delivery costs more than one slot. Eight is measured, not derived; the
  //    array stays 10 wide so the unused slots are simply skipped by `count`.
  const BATCH = 8;
  const mintedNotes: { tokenId: number; randomness: string; txHash: string }[] = [];
  // Captured BEFORE the loop: `minted` is declared after it, and referencing it
  // from inside threw "Cannot access 'minted' before initialization" — at mint
  // time, after the tx had already landed.
  const priorCardIds: number[] = existsSync(manifestPath(index))
    ? (JSON.parse(readFileSync(manifestPath(index), 'utf-8')) as BotManifest).cardIds ?? []
    : [];
  /** The contract's array width. Slots past `count` are zero and ignored. */
  const ARRAY_WIDTH = 10;
  const plan = collection.slice(0, toMint);
  for (let i = 0; i < plan.length; i += BATCH) {
    const batch = plan.slice(i, i + BATCH);
    const ids = Array.from({ length: ARRAY_WIDTH }, (_, k) => new Fr(BigInt(batch[k]?.id ?? 0)));
    const ranks = Array.from({ length: ARRAY_WIDTH }, (_, k) => new Fr(BigInt(batch[k]?.packed ?? 0)));
    // Randomness per note. It must be unique — it is what distinguishes two
    // notes of the same card id, and therefore what makes their nullifiers
    // differ — and it must be RECORDED, because untagged notes are invisible
    // to the bot until it imports them with exactly these values.
    const rand = Array.from({ length: ARRAY_WIDTH }, () => Fr.random());
    try {
      const txHash = await nft.methods
        .mint_bot_cards(new Fr(BigInt(index)), ids, ranks, rand, batch.length)
        .send({
          from: deployer.address,
          fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
          wait: { timeout: TX_TIMEOUT },
        });
      // send() here resolves to { receipt, offchainEffects, offchainMessages },
      // and receipt.txHash is a TxHash OBJECT. String()ing the outer value gave
      // "[object Object]" for every note, which only surfaced a thousand notes
      // later at import time as "invalid string" — cards minted, recorded, and
      // unimportable. Accept either shape and fail LOUDLY at mint time.
      const r = txHash as any;
      const hash = (r?.receipt?.txHash ?? r?.txHash)?.toString();
      if (!hash || hash.startsWith('[object')) {
        throw new Error(`mint_bot_cards returned no usable txHash (got ${String(hash)})`);
      }
      for (let k = 0; k < batch.length; k++) {
        mintedNotes.push({ tokenId: batch[k].id, randomness: rand[k].toString(), txHash: hash });
      }
      // Persist the plaintexts NOW, not at the end of the run. They are the only
      // way these notes can ever be imported, so an interrupted or clobbered run
      // must not be able to lose more than the batch in flight.
      persistNotes(index, botAddress, keys, Number(rollupVersion), mintedNotes,
        [...priorCardIds, ...plan.slice(0, i + batch.length).map(c => c.id)]);
      console.log(`  minted ${Math.min(i + BATCH, plan.length)}/${plan.length}`);
    } catch (err: any) {
      // Do not silently continue: a partial collection that reports success is
      // worse than a loud stop, because the bot would then commit hands it
      // cannot back.
      throw new Error(`bot mint failed after ${i} cards: ${String(err?.message ?? err)}`);
    }
  }
  // The full multiset this identity has been minted, for the manifest.
  const minted = [...priorCardIds, ...plan.map(c => c.id)];

  // 5. VERIFY.
  //
  // NOT by reading the collection back: mint_bot_cards creates UNTAGGED notes,
  // which this PXE cannot discover either — that is the whole point of using
  // them. The provisioner's job ends at "the mints landed and their plaintexts
  // are recorded"; whether the bot can SEE them is settled when BotChain imports
  // from the manifest, which is where a real count is available.
  const held = await readCollection(nft, botAccount.address);
  // Read from the manifest, which persistNotes has been maintaining as we
  // minted — adding mintedNotes on top would count this run twice.
  const totalNotes = previousMintedTotal(index);
  if (totalNotes < HAND_SIZE) {
    throw new Error(
      `verification failed: only ${totalNotes} note(s) recorded — the bot needs at least ` +
      `${HAND_SIZE} to field a hand.`,
    );
  }
  console.log(
    `  ✓ ${mintedNotes.length} card(s) minted this run, ${totalNotes} recorded in total ` +
    `(${held.length} already discoverable in this PXE; the rest import from the manifest)`,
  );

  // Route the final write through persistNotes as well, rather than
  // concatenating again. Reading the file back and appending mintedNotes on top
  // double-counted every note this run had already written — 60 cards, 120 note
  // records — which then doubles the bot's import work at every boot.
  persistNotes(index, botAddress, keys, Number(rollupVersion), mintedNotes, minted);
  const outPath = manifestPath(index);
  console.log(`\n=== Done. Manifest: ${outPath} ===`);
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
