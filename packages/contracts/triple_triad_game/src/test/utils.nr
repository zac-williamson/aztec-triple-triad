use crate::TripleTriadGame;
use triple_triad_nft::{test_support, TripleTriadNFT};
use arena_token::ArenaToken;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use compressed_string::FieldCompressedString;

/// Full three-contract setup: ArenaToken + TripleTriadNFT + TripleTriadGame.
/// Returns (env, game_addr, nft_addr, token_addr, player1, player2).
/// Both players have 5 private NFT cards (via mint_to_private) and nonce initialized.
pub unconstrained fn setup_game() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (env, game, nft, token, player1, player2, _admin) = setup_game_with_admin();
    (env, game, nft, token, player1, player2)
}

/// `setup_game`, also returning the admin (the NFT's minter).
pub unconstrained fn setup_game_with_admin() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let player1 = env.create_light_account();
    let player2 = env.create_light_account();

    // Deploy ArenaToken
    let token_init = ArenaToken::interface().constructor(admin);
    let token_addr = env.deploy("@arena_token/ArenaToken").with_public_initializer(admin, token_init);

    // Deploy TripleTriadNFT
    let nft_init = TripleTriadNFT::interface().constructor(
        admin,
        FieldCompressedString::from_string("TripleTriadNFT00000000000000000"),
        FieldCompressedString::from_string("TTNFT00000000000000000000000000"),
    );
    let nft_addr = env.deploy("@triple_triad_nft/TripleTriadNFT").with_public_initializer(admin, nft_init);

    // Deploy TripleTriadGame. The VK hashes are placeholders: TXE executes a
    // private function without proving it, so the move proofs a test passes
    // are never checked against them.
    let game_init = TripleTriadGame::interface().constructor(
        admin,
        nft_addr,
        2,     // move_vk_hash (placeholder)
        4,     // hand_vk_hash (placeholder)
        token_addr,
        3,     // dummy_vk_hash (placeholder)
        false, // permissive_vks: all three differ, so the sound configuration
    );
    let game_addr = env.deploy("TripleTriadGame").with_public_initializer(admin, game_init);

    // Wire cross-references
    env.call_public(admin, TripleTriadNFT::at(nft_addr).set_game_contract(game_addr));
    env.call_public(admin, TripleTriadNFT::at(nft_addr).set_token_contract(token_addr));
    env.call_public(admin, ArenaToken::at(token_addr).set_nft_contract(nft_addr));
    env.call_public(admin, ArenaToken::at(token_addr).set_game_contract(game_addr));

    // Mint 5 cards to each player via mint_to_private (standard note insertion)
    // Player 1 gets cards [1,2,3,4,5]
    for i in 0..5 {
        env.call_private(
            admin,
            TripleTriadNFT::at(nft_addr).mint_to_private(player1, (i + 1) as Field, 0),
        );
    }
    // Player 2 gets cards [6,7,8,9,10]
    for i in 0..5 {
        env.call_private(
            admin,
            TripleTriadNFT::at(nft_addr).mint_to_private(player2, (i + 6) as Field, 0),
        );
    }

    // Initialize nonce for both players (commit_hand consumes it)
    test_support::init_note_nonce(env, nft_addr, player1, 5);
    test_support::init_note_nonce(env, nft_addr, player2, 5);

    (env, game_addr, nft_addr, token_addr, player1, player2, admin)
}

// ---------------------------------------------------------------------------
// Private-games helpers (docs/plan/PRIVATE_GAMES.md)
// ---------------------------------------------------------------------------

/// The key the two test players share, standing in for their key exchange.
pub global KEY: Field = 0x5eed5eed;
pub global P1_HAND: [Field; 5] = [1, 2, 3, 4, 5];
pub global P2_HAND: [Field; 5] = [6, 7, 8, 9, 10];
/// Both players' note nonce when they commit (setup_game initialises it to 5).
pub global NONCE: Field = 5;

pub unconstrained fn create(env: TestEnvironment, game: AztecAddress, player: AztecAddress) -> [Field; 9] {
    env.call_private(player, TripleTriadGame::at(game).create_game(KEY, P1_HAND))
}

pub unconstrained fn join(
    env: TestEnvironment,
    game: AztecAddress,
    player: AztecAddress,
    record_1: [Field; 9],
) -> [Field; 9] {
    env.call_private(player, TripleTriadGame::at(game).join_game(KEY, record_1, P2_HAND))
}

/// `[blinding, r_0..r_4, prize_randomness, reward_randomness]` of a player's
/// game at NONCE.
pub unconstrained fn secrets(env: TestEnvironment, nft: AztecAddress, player: AztecAddress) -> [Field; 8] {
    env.view_private(player, TripleTriadNFT::at(nft).compute_game_secrets(NONCE))
}

/// A nine-move transcript that satisfies the settlement's checks. TXE runs a
/// private function without proving it, so the proofs themselves are never
/// checked here; what IS checked is everything the contract does with their
/// public inputs. Player 1 places its hand in slot order at moves 0,2,4,6,8;
/// player 2 places slots 0..3 at moves 1,3,5,7.
pub unconstrained fn transcript(
    hand_commit_1: Field,
    hand_commit_2: Field,
    winner_id: Field,
) -> [[Field; 8]; 9] {
    let mut moves: [[Field; 8]; 9] = [[0; 8]; 9];
    let mut state = crate::compute_initial_state_hash();
    for i in 0..9 {
        let next = (i as Field + 1) * 1000 + 7;
        let p1_moves = i % 2 == 0;
        let slot = i / 2;
        let card = if p1_moves { P1_HAND[slot] } else { P2_HAND[slot] };
        let ended = if i == 8 { 1 } else { 0 };
        let winner = if i == 8 { winner_id } else { 0 };
        moves[i] = [hand_commit_1, hand_commit_2, state, next, ended, winner, card, slot as Field];
        state = next;
    }
    moves
}

pub unconstrained fn settle(
    env: TestEnvironment,
    from: AztecAddress,
    game: AztecAddress,
    record_1: [Field; 9],
    record_2: [Field; 9],
    moves: [[Field; 8]; 9],
    prize_move: Field,
) {
    let p: [Field; 458] = [0; 458];
    let vk: [Field; 115] = [0; 115];
    env.call_private(
        from,
        TripleTriadGame::at(game).settle_game(
            KEY, record_1, record_2, vk,
            p, moves[0], p, moves[1], p, moves[2], p, moves[3], p, moves[4],
            p, moves[5], p, moves[6], p, moves[7], p, moves[8],
            prize_move,
        ),
    );
}

/// Import a reward the last tx released to `owner`.
pub unconstrained fn import_reward(
    env: TestEnvironment,
    token: AztecAddress,
    owner: AztecAddress,
    randomness: Field,
    tx: (Field, [Field; 64], u32, Field),
) {
    let (tx_hash, hashes, count, first_nullifier) = tx;
    env.execute_utility(
        ArenaToken::at(token).import_note(owner, 20, randomness, tx_hash, hashes, count, first_nullifier, owner),
    );
}

pub unconstrained fn balance(env: TestEnvironment, token: AztecAddress, owner: AztecAddress) -> u128 {
    env.execute_utility(ArenaToken::at(token).get_balance(owner))
}

/// Sorted copy of a player's cards, for comparing collections.
pub unconstrained fn sorted_cards(env: TestEnvironment, nft: AztecAddress, owner: AztecAddress) -> BoundedVec<Field, 40> {
    let cards = test_support::cards_of(env, nft, owner);
    let mut out: BoundedVec<Field, 40> = BoundedVec::new();
    let mut taken: [bool; 40] = [false; 40];
    for _ in 0..cards.len() {
        let mut best: u32 = 0;
        let mut best_val: u32 = 4294967295;
        for j in 0..cards.len() {
            let v = cards.get(j) as u32;
            if !taken[j] & (v < best_val) {
                best = j;
                best_val = v;
            }
        }
        taken[best] = true;
        out.push(cards.get(best));
    }
    out
}

/// Assert `owner` holds exactly `expected` (any order).
pub unconstrained fn assert_cards<let N: u32>(
    env: TestEnvironment,
    nft: AztecAddress,
    owner: AztecAddress,
    expected_sorted: [Field; N],
) {
    let got = sorted_cards(env, nft, owner);
    assert_eq(got.len(), N, "wrong number of cards");
    for i in 0..N {
        assert_eq(got.get(i), expected_sorted[i], "wrong card in the collection");
    }
}

/// A fresh account holding `hand` (ids nobody else holds) with a note nonce,
/// ready to commit.
pub unconstrained fn player_with(env: &mut TestEnvironment, nft: AztecAddress, admin: AztecAddress, hand: [Field; 5]) -> AztecAddress {
    let player = env.create_light_account();
    give(*env, nft, admin, player, hand);
    test_support::init_note_nonce(*env, nft, player, 5);
    player
}

/// Mint `hand` to an existing account.
pub unconstrained fn give(env: TestEnvironment, nft: AztecAddress, admin: AztecAddress, player: AztecAddress, hand: [Field; 5]) {
    for i in 0..5 {
        env.call_private(admin, TripleTriadNFT::at(nft).mint_to_private(player, hand[i], 0));
    }
}
