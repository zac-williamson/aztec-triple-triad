use crate::TripleTriadNFT;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use compressed_string::FieldCompressedString;

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let minter = env.create_light_account();
    let player = env.create_light_account();

    let initializer_call = TripleTriadNFT::interface().constructor(
        minter,
        FieldCompressedString::from_string("TripleTriadNFT00000000000000000"),
        FieldCompressedString::from_string("TTNFT00000000000000000000000000"),
    );
    let contract_address =
        env.deploy("TripleTriadNFT").with_public_initializer(minter, initializer_call);

    (env, contract_address, minter, player)
}
