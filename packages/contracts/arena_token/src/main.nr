use aztec::macros::aztec;

/// Arena Token - private fungible token for the Triple Triad game.
///
/// Minting authority is shared between admin, NFT contract, and game contract.
/// - NFT contract mints 100 tokens during new player onboarding
/// - Game contract mints 20 tokens to each player after settlement
/// - NFT contract burns 100 tokens when a player purchases a card pack
#[aztec]
pub contract ArenaToken {
    use aztec::{
        macros::{
            functions::{external, initializer},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Owned, PublicImmutable},
    };

    use balance_set::BalanceSet;

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        nft_contract: PublicImmutable<AztecAddress, Context>,
        game_contract: PublicImmutable<AztecAddress, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        self.storage.admin.initialize(admin);
    }

    /// Set the NFT contract address. Admin only. Can only be called once.
    #[external("public")]
    fn set_nft_contract(addr: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "Only admin");
        self.storage.nft_contract.initialize(addr);
    }

    /// Set the game contract address. Admin only. Can only be called once.
    #[external("public")]
    fn set_game_contract(addr: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "Only admin");
        self.storage.game_contract.initialize(addr);
    }

    /// Mint tokens to a recipient's private balance.
    /// Only callable by admin, NFT contract, or game contract.
    #[external("private")]
    fn mint_private(to: AztecAddress, amount: u128) {
        let caller = self.msg_sender();
        let admin = self.storage.admin.read();
        let nft = self.storage.nft_contract.read();
        let game = self.storage.game_contract.read();
        assert(
            (caller == admin) | (caller == nft) | (caller == game),
            "Unauthorized: only admin, NFT, or game contract can mint",
        );

        self.storage.balances.at(to).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    /// Burn tokens from a player's private balance.
    /// Only callable by the NFT contract (for card pack purchases).
    /// The `from` address is the player whose tokens are burned.
    #[external("private")]
    fn burn_from(from: AztecAddress, amount: u128) {
        let caller = self.msg_sender();
        let nft = self.storage.nft_contract.read();
        assert(caller == nft, "Only NFT contract can burn");

        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    /// Query a player's private token balance (unconstrained, runs client-side).
    #[external("utility")]
    unconstrained fn get_balance(owner: AztecAddress) -> u128 {
        self.storage.balances.at(owner).balance_of()
    }
}
