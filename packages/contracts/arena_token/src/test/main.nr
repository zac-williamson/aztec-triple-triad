use crate::ArenaToken;
use crate::test::utils;
use aztec::protocol::constants::MAX_NOTE_HASHES_PER_TX;
use aztec::protocol::traits::FromField;
use aztec::test::helpers::txe_oracles::get_last_tx_effects;
use aztec::note::note_interface::NoteHash;
use aztec::protocol::address::AztecAddress;
use uint_note::UintNote;

// --- Constructor ---

#[test]
unconstrained fn constructor_sets_admin() {
    let (mut env, contract_address, admin, _user) = utils::setup();

    // Admin can call set_nft_contract (only admin allowed)
    let nft_addr = env.create_light_account();
    env.call_public(admin, ArenaToken::at(contract_address).set_nft_contract(nft_addr));
    // If we got here without assertion error, admin is correctly set
}

// --- Access control ---

#[test(should_fail_with = "Only admin")]
unconstrained fn set_nft_contract_rejects_non_admin() {
    let (mut env, contract_address, _admin, user) = utils::setup();
    let nft_addr = env.create_light_account();
    env.call_public(user, ArenaToken::at(contract_address).set_nft_contract(nft_addr));
}

#[test(should_fail_with = "Only admin")]
unconstrained fn set_game_contract_rejects_non_admin() {
    let (mut env, contract_address, _admin, user) = utils::setup();
    let game_addr = env.create_light_account();
    env.call_public(user, ArenaToken::at(contract_address).set_game_contract(game_addr));
}

// --- Minting ---

#[test]
unconstrained fn admin_can_mint_tokens() {
    let (mut env, contract_address, admin, user, _nft, _game) = utils::setup_full();

    env.call_private(admin, ArenaToken::at(contract_address).mint_private(user, 100));

    let balance: u128 = env.execute_utility(ArenaToken::at(contract_address).get_balance(user));
    assert(balance == 100, "Expected 100 tokens");
}

#[test(should_fail_with = "Unauthorized")]
unconstrained fn unauthorized_caller_cannot_mint() {
    let (mut env, contract_address, _admin, user, _nft, _game) = utils::setup_full();

    // User (not admin/nft/game) tries to mint
    env.call_private(user, ArenaToken::at(contract_address).mint_private(user, 100));
}

// --- Balance ---

#[test]
unconstrained fn get_balance_returns_zero_for_new_account() {
    let (mut env, contract_address, _admin, user) = utils::setup();

    let balance: u128 = env.execute_utility(ArenaToken::at(contract_address).get_balance(user));
    assert(balance == 0, "Expected 0 tokens");
}

#[test]
unconstrained fn get_balance_correct_after_mint() {
    let (mut env, contract_address, admin, user, _nft, _game) = utils::setup_full();

    env.call_private(admin, ArenaToken::at(contract_address).mint_private(user, 50));
    env.call_private(admin, ArenaToken::at(contract_address).mint_private(user, 30));

    let balance: u128 = env.execute_utility(ArenaToken::at(contract_address).get_balance(user));
    assert(balance == 80, "Expected 80 tokens");
}

// --- Burning ---

// Note: burn_from requires caller == from's owner due to Owned<BalanceSet>.
// In production, the NFT contract calls burn_from with authwit.
// TXE doesn't easily simulate cross-contract authwit, so we test burn via
// having the user call it through the NFT contract (which is the real flow).
// For now, test that admin can at least mint and check the balance decrements
// when the balance owner themselves calls burn (if that were possible).
// This test verifies the access control of burn_from itself.
#[test(should_fail_with = "Balance too low")]
unconstrained fn burn_from_fails_with_zero_balance() {
    let (mut env, contract_address, _admin, user, nft_account, _game) = utils::setup_full();

    // NFT contract tries to burn from user with zero balance
    env.call_private(nft_account, ArenaToken::at(contract_address).burn_from(user, 40));
}

#[test(should_fail_with = "Only NFT contract can burn")]
unconstrained fn non_nft_cannot_burn() {
    let (mut env, contract_address, admin, user, _nft, _game) = utils::setup_full();

    // Mint tokens first
    env.call_private(admin, ArenaToken::at(contract_address).mint_private(user, 100));

    // Admin (not NFT contract) tries to burn
    env.call_private(admin, ArenaToken::at(contract_address).burn_from(user, 40));
}

// --- Prepared reward notes (docs/plan/PRIVATE_GAMES.md section 3.6) ---

/// A player's reward note, as their commit prepares it: owner, amount and
/// randomness all fixed by the owner, so the game can release it knowing none
/// of them.
unconstrained fn prepared_reward(owner: AztecAddress, randomness: Field) -> Field {
    UintNote { value: 20 }.compute_note_hash(owner, ArenaToken::storage_layout().balances.slot, randomness)
}

#[test]
unconstrained fn a_released_reward_is_importable_by_its_owner() {
    let (mut env, contract_address, _admin, recipient, _nft, game) = utils::setup_full();
    let randomness = 4242;

    env.call_private(
        game,
        ArenaToken::at(contract_address).release_reward_notes([prepared_reward(recipient, randomness), 0]),
    );
    let effects = get_last_tx_effects();

    // Released notes carry no tag or message: nothing is discovered passively.
    let before: u128 = env.execute_utility(ArenaToken::at(contract_address).get_balance(recipient));
    assert(before == 0, "a released reward must not be discovered before import");

    let mut hashes: [Field; 64] = [0; 64];
    for i in 0..MAX_NOTE_HASHES_PER_TX {
        if i < effects.note_hashes.len() {
            hashes[i] = effects.note_hashes.get(i);
        }
    }
    env.execute_utility(ArenaToken::at(contract_address).import_note(
        recipient,
        20,
        randomness,
        effects.tx_hash,
        hashes,
        effects.note_hashes.len(),
        effects.nullifiers.get(0),
        recipient,
    ));

    let after: u128 = env.execute_utility(ArenaToken::at(contract_address).get_balance(recipient));
    assert(after == 20, "the owner's balance must be +20 after importing their reward");
}

#[test(should_fail_with = "Only game contract can release rewards")]
unconstrained fn only_the_game_can_release_rewards() {
    let (mut env, contract_address, _admin, user, _nft, _game) = utils::setup_full();
    env.call_private(
        user,
        ArenaToken::at(contract_address).release_reward_notes([prepared_reward(user, 1), 0]),
    );
}

// Upgradeability removed: updates are fresh redeploys (docs/plan/UPDATE_MODEL.md).
