/**
 * Harness-side public chain client — the third pair of eyes. Reads public
 * game state straight from the sandbox node via its own ephemeral wallet,
 * independent of both browser PXEs, so "frontend thinks it settled but the
 * chain disagrees" is caught here.
 *
 * Mirrors the Node wallet pattern of scripts/deploy-contracts.ts and
 * packages/integration/tests (ephemeral EmbeddedWallet + Contract.at).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ROOT, PXE_URL, type ContractAddresses } from './env.js';

/** game_status values written by TripleTriadGame (see contracts main.nr). */
export const GAME_STATUS = {
  none: 0,
  created: 1,
  active: 2,
  settled: 3,
  cancelled: 4,
  abandoned_claimed: 5,
} as const;

export class ChainClient {
  private constructor(
    private readonly gameContract: any,
    private readonly Fr: any,
    private readonly fromAddr: any,
  ) {}

  static async connect(addresses: ContractAddresses): Promise<ChainClient> {
    const [{ createAztecNodeClient }, { EmbeddedWallet }, { Fr }, { AztecAddress }, { GrumpkinScalar }, { Contract }, { loadContractArtifact }] =
      await Promise.all([
        import('@aztec/aztec.js/node'),
        import('@aztec/wallets/embedded'),
        import('@aztec/aztec.js/fields'),
        import('@aztec/aztec.js/addresses'),
        import('@aztec/foundation/curves/grumpkin'),
        import('@aztec/aztec.js/contracts'),
        import('@aztec/aztec.js/abi'),
      ]);

    const node = createAztecNodeClient(PXE_URL);
    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    // Reads only — a registered (undeployed) account supplies the `from`.
    const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());

    const gameArtifactRaw = JSON.parse(readFileSync(
      resolve(ROOT, 'packages/contracts/target/triple_triad_game-TripleTriadGame.json'), 'utf-8'));
    const gameArtifact = loadContractArtifact(gameArtifactRaw);
    const gameAddr = AztecAddress.fromString(addresses.game);
    const instance = await node.getContract(gameAddr);
    if (!instance) throw new Error(`Game contract not found on-chain at ${addresses.game}`);
    await wallet.registerContract(instance, gameArtifact);
    const gameContract = await Contract.at(gameAddr, gameArtifact, wallet);

    return new ChainClient(gameContract, Fr, account.address);
  }

  private fr(hex: string) {
    return this.Fr.fromHexString(hex);
  }

  async gameStatus(onChainGameIdHex: string): Promise<number> {
    const { result } = await this.gameContract.methods
      .get_game_status(this.fr(onChainGameIdHex))
      .simulate({ from: this.fromAddr });
    return Number(BigInt(result.toString()));
  }

  async gamePlayers(onChainGameIdHex: string): Promise<{ player1: string; player2: string }> {
    const gameId = this.fr(onChainGameIdHex);
    const { result: p1 } = await this.gameContract.methods
      .get_game_player1(gameId).simulate({ from: this.fromAddr });
    const { result: p2 } = await this.gameContract.methods
      .get_game_player2(gameId).simulate({ from: this.fromAddr });
    return { player1: p1.toString(), player2: p2.toString() };
  }
}
