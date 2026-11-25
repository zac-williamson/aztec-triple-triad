/**
 * No contract we deploy carries an entry point nobody reviewed.
 *
 * The NFT deployed on 20 November 2026 carried eight test-only entry points
 * written for its contract tests, and anyone could call them on the deployed
 * contract. Three minted cards of the caller's choosing: `test_mint_winner_cards` and its
 * `_with_nonce` twin were `mint_for_game_winner` without the game-contract
 * check, to any address, and `test_create_10_cards` minted ten to the caller.
 * Contract tests now set state up through the test environment instead
 * (`triple_triad_nft/src/test_support.nr`).
 *
 * The NFT's list below is exact, so a new entry point fails this test until it
 * is added here — which is the moment to ask who may call it. Every function
 * that creates a card note says who that is (docs/plan/AUDIT_INVARIANTS.md, Z4).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? __dirname, '..');
const CONTRACTS = [
  'arena_token-ArenaToken',
  'triple_triad_nft-TripleTriadNFT',
  'triple_triad_game-TripleTriadGame',
];

/** The entry points of the artifact the site serves (and the deploy uses). */
function entryPoints(name: string): string[] {
  const path = join(ROOT, 'packages/frontend/public/contracts', `${name}.json`);
  return (JSON.parse(readFileSync(path, 'utf8')).functions ?? []).map((f: { name: string }) => f.name).sort();
}

const isTestOnly = (fn: string) => /(^test_|_test$)/.test(fn);

const NFT: Record<string, string> = {
  // Create card notes, and who may call them.
  get_cards_for_new_player: 'creates cards: any account, once (the starter claim)',
  purchase_card_pack: 'creates cards: any account, burning CARD_PACK_COST tokens',
  release_game_cards:
    'creates cards: the game contract, releasing notes prepared by the owners\' own commits (settle, cancel, unwind)',
  mint_to_private: 'creates cards: the minter',
  mint_to_public: 'creates cards: the minter',
  mint_bot_cards: 'creates cards: the minter, for a registered arena bot',
  transfer_private: 'creates cards: the owner, consuming the card moved',
  reclaim_card: 'creates cards: the public owner, consuming public ownership',
  // Consume or move cards.
  commit_hand: 'consumes cards: the game contract, inside the owner\'s own tx',
  transfer_private_to_public: 'consumes cards: the owner',
  transfer_public: 'moves a public card: its public owner',
  // Derivations, read through simulate.
  compute_game_secrets: 'derivation (view, the caller\'s own secrets)',
  compute_note_randomness: 'derivation',
  preview_card_ids: 'derivation',
  preview_commit: 'derivation (view, the owner or the game contract)',
  // Setup: the minter, each address set once.
  constructor: 'setup',
  set_game_contract: 'setup',
  set_token_contract: 'setup',
  set_arena_bot: 'setup',
  // #[only_self]: reachable only from the contract's own private functions.
  finalize_bot_mint: 'only_self',
  finalize_mint: 'only_self',
  finalize_reclaim: 'only_self',
  set_public_owner: 'only_self',
  // Reads.
  get_card_ranks: 'view',
  public_get_name: 'view',
  public_get_symbol: 'view',
  public_owner_of: 'view',
  get_nfts_for_user: 'utility',
  get_note_nonce: 'utility',
  import_note: 'utility (recovery; cannot change chain state)',
  // Injected by #[aztec].
  offchain_receive: 'framework',
  sync_state: 'framework',
  public_dispatch: 'framework',
};

/**
 * The game holds no public state (docs/plan/PRIVATE_GAMES.md): every entry
 * point but the constructor and one immutable read is private, so nothing a
 * game does names the contract on-chain. A new public function here would
 * bring public calls -- and with them linkable game transactions -- back.
 */
const GAME: Record<string, string> = {
  create_game: 'private',
  join_game: 'private',
  cancel_game: 'private: the creator, proven by seat',
  settle_game: 'private: anyone with both records and the transcript',
  claim_abandoned_game: 'private: a player, proven by seat; takes one of the other player\'s open cards',
  contest_abandonment: 'private: the other player, proven by seat',
  finalize_abandoned_game: 'private: anyone, after the window, naming the claim\'s terms',
  preview_record: 'derivation (view)',
  game_nullifiers: 'utility',
  forfeit_nullifiers: 'utility: the terms a claim could have',
  constructor: 'setup',
  has_permissive_vks: 'view (immutable)',
  offchain_receive: 'framework',
  sync_state: 'framework',
  public_dispatch: 'framework',
};

describe('deployed entry points', () => {
  it('no shipped contract has a test-only entry point', () => {
    const found = CONTRACTS.flatMap(c => entryPoints(c).filter(isTestOnly).map(fn => `${c}.${fn}`));
    expect(found, 'test helpers belong in the test environment, never on the contract').toEqual([]);
  });

  it('the NFT has exactly the reviewed entry points', () => {
    expect(
      entryPoints('triple_triad_nft-TripleTriadNFT'),
      'the NFT gained or lost an entry point: review who may call it, then update this list',
    ).toEqual(Object.keys(NFT).sort());
  });

  it('the game has exactly the reviewed entry points', () => {
    expect(
      entryPoints('triple_triad_game-TripleTriadGame'),
      'the game gained or lost an entry point: a public one would make games linkable again',
    ).toEqual(Object.keys(GAME).sort());
  });
});
