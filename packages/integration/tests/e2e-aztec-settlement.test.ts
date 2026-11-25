// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Aztec Settlement Test -- a private game, end to end, with REAL proofs
 * (docs/plan/PRIVATE_GAMES.md).
 *
 * Validates that two players can:
 * 1. Deploy NFT + Token + Game contracts
 * 2. Create and join a game knowing only a shared game key and each other's
 *    records -- no address, randomness or blinding factor is exchanged
 * 3. Prove all nine moves against their on-chain hand commitments
 * 4. Settle with settle_game (nine real recursive proofs)
 * 5. Each import ONLY their own notes from the settlement tx, rebuilt from
 *    secrets they already hold -- including the winner's prize card
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: aztec compile (from packages/contracts)
 *   - Circuits compiled: cd circuits && nargo compile
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-aztec-settlement.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Aztec SDK
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { Contract } from '@aztec-labs/aztec.js/contracts';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';


// bb.js
import { Barretenberg } from '@aztec-foundation/bb.js';

// Shared helpers
import {
  computeVkHash,
  computeCardCommit,
  generateFullGameProofs,
  loadContractArtifact,
  loadCircuitArtifact,
  fundAndDeployAccount,
} from './e2e-helpers.js';

// ============================================================================
// Configuration
// ============================================================================

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300; // seconds

// ============================================================================
// Helpers
// ============================================================================

/** Safe string-to-Fr conversion: handles both hex and decimal strings */
function toFr(s: string | any): any {
  if (s instanceof Fr) return s;
  const str = s.toString();
  if (str.startsWith('0x') || str.startsWith('0X')) {
    return Fr.fromHexString(str);
  }
  return new Fr(BigInt(str));
}

/** Normalize a value to 0x-prefixed hex string */
function toHex(v: any): string {
  const s = v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return s;
  return '0x' + BigInt(s).toString(16);
}

/**
 * Import notes created by create_and_push_note into PXE.
 * This is required because create_and_push_note skips on-chain tagging.
 */
async function importNotes(
  nftContract: any,
  node: any,
  txHash: any,
  owner: any,
  cardIds: number[],
  randomnessFrs: any[],
) {
  // Fetch TxEffect
  let txEffect: any = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const txResult = await node.getTxEffect(txHash);
      if (txResult?.data) { txEffect = txResult.data; break; }
    } catch { /* not indexed yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!txEffect) {
    console.warn('  Could not fetch TxEffect for note import');
    return;
  }

  const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
  const uniqueNoteHashes: string[] = rawNoteHashes
    .map((h: any) => h.toString())
    .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
  const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

  const paddedHashes = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
    paddedHashes[i] = toFr(uniqueNoteHashes[i]);
  }

  const txHashFr = toFr(txHash.toString());
  const firstNullFr = toFr(firstNullifier);

  for (let i = 0; i < cardIds.length; i++) {
    try {
      await nftContract.methods
        .import_note(
          owner,
          new Fr(BigInt(cardIds[i])),
          randomnessFrs[i],
          txHashFr,
          paddedHashes,
          uniqueNoteHashes.length,
          firstNullFr,
          owner,
        )
        .simulate({ from: owner });
      console.log(`  Imported note for card ${cardIds[i]}`);
    } catch (err: any) {
      console.warn(`  Failed to import note for card ${cardIds[i]}:`, err?.message?.slice(0, 120));
    }
  }
}

describe('E2E Aztec Settlement', () => {
  // Aztec state
  let wallet: any;
  let node: any;
  let deployerAddr: any;
  let p1Addr: any;
  let p2Addr: any;
  let nftContract: any;
  let gameContract: any;
  let tokenContract: any;
  /** Fields in an UltraHonkZKProof, read off settle_game's ABI (no magic number). */
  let proofLength: number;

  // Barretenberg + circuit artifacts
  let api: Barretenberg;
  let gameMoveArtifact: any;
  let realMoveVkFields: any[];

  // Helper: send options for a given address. No `fee` — each account pays
  // natively from the Fee Juice it claimed at deploy (SponsoredFPC is BANNED).
  const sendAs = (addr: any) => ({
    from: addr,
    wait: { timeout: SEND_TIMEOUT },
  });

  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [1, 2, 3, 4, 5]; // Both players use starter cards

  beforeAll(async () => {
    // --- Connect to Aztec node ---
    console.log(`Connecting to Aztec node at ${PXE_URL}...`);
    node = createAztecNodeClient(PXE_URL);

    // --- Wait for node to have blocks ---
    console.log('Waiting for Aztec node to have blocks...');
    for (let i = 0; i < 120; i++) {
      try {
        const blockNum = await node.getBlockNumber();
        if (blockNum > 0) {
          // v6 removed AztecNode.getBlockHeader(); getBlockData is the header-only fetch.
          const header = (await node.getBlockData(blockNum))?.header;
          console.log(`  Node at block ${blockNum}, timestamp=${header?.globalVariables?.timestamp ?? 'unknown'}`);
          break;
        }
      } catch { /* node not ready yet */ }
      if (i === 119) throw new Error('Node never produced blocks');
      await new Promise(r => setTimeout(r, 1000));
    }

    // --- Create wallet ---
    console.log('Creating EmbeddedWallet...');
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    // --- Wait for PXE to sync ---
    console.log('Waiting for embedded PXE to sync...');
    await new Promise(r => setTimeout(r, 5000));

    // --- Create accounts; fund each with Fee Juice + deploy (Fee Juice
    //     only, SponsoredFPC BANNED). Each then pays its own txs natively. ---
    console.log('Creating deployer account...');
    const deployerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await fundAndDeployAccount(node, deployerAccount, 'Deployer', SEND_TIMEOUT);
    deployerAddr = deployerAccount.address;
    await wallet.registerSender(deployerAddr, 'deployer');
    console.log(`  Deployer: ${deployerAddr}`);

    console.log('Creating player 1 account...');
    const player1Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await fundAndDeployAccount(node, player1Account, 'Player1', SEND_TIMEOUT);
    p1Addr = player1Account.address;
    await wallet.registerSender(p1Addr, 'player1');
    console.log(`  Player 1: ${p1Addr}`);

    console.log('Creating player 2 account...');
    const player2Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await fundAndDeployAccount(node, player2Account, 'Player2', SEND_TIMEOUT);
    p2Addr = player2Account.address;
    await wallet.registerSender(p2Addr, 'player2');
    console.log(`  Player 2: ${p2Addr}`);

    // --- Init Barretenberg & compute VK hashes ---
    console.log('Initializing Barretenberg...');
    api = await Barretenberg.new({ threads: 1 });
    gameMoveArtifact = loadCircuitArtifact('game_move');

    console.log('Computing VK hashes...');
    const moveVk = await computeVkHash(api, gameMoveArtifact.bytecode);
    // The constructor also takes the dummy circuit's VK hash, so it can refuse
    // the dummy as a move VK on a sound deployment.
    const dummyVk = await computeVkHash(api, loadCircuitArtifact('dummy_move').bytecode);
    console.log(`  move_vk_hash: ${moveVk.hash}`);

    realMoveVkFields = moveVk.fields.map((f: string) => Fr.fromHexString(f));

    // --- Deploy contracts ---
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    const gameArtifact = loadContractArtifact('triple_triad_game-TripleTriadGame');
    const tokenArtifact = loadContractArtifact('arena_token-ArenaToken');
    const moveProofParam = gameArtifact.functions
      .find((f: any) => f.name === 'settle_game')
      .parameters.find((p: any) => p.name === 'move_proof_1');
    proofLength = moveProofParam.type.length; // UltraHonkZKProof is [Field; N]

    console.log('Deploying TripleTriadNFT...');
    function encodeCompressedString(s: string): Fr {
      let hex = '';
      for (let i = 0; i < s.length && i < 31; i++) {
        hex += s.charCodeAt(i).toString(16).padStart(2, '0');
      }
      return new Fr(BigInt('0x' + hex));
    }
    const nameField = encodeCompressedString('TestCards');
    const symbolField = encodeCompressedString('TC');
    ({ contract: nftContract } = await Contract.deploy(wallet, nftArtifact, [
      deployerAddr,
      nameField,
      symbolField,
    ]).send(sendAs(deployerAddr)));
    console.log(`  NFT deployed at: ${nftContract.address}`);

    await wallet.registerSender(nftContract.address, 'nft-contract');

    console.log('Deploying TripleTriadGame...');
    ({ contract: tokenContract } = await Contract.deploy(wallet, tokenArtifact, [
      deployerAddr,
    ]).send(sendAs(deployerAddr)));
    await wallet.registerSender(tokenContract.address, 'token-contract');

    // Constructor: (admin, nft, move_vk_hash, token, dummy_vk_hash,
    // permissive_vks) -- as scripts/deploy-contracts.ts deploys it, real VKs only.
    ({ contract: gameContract } = await Contract.deploy(wallet, gameArtifact, [
      deployerAddr,
      nftContract.address,
      Fr.fromHexString(moveVk.hash),
      tokenContract.address,
      Fr.fromHexString(dummyVk.hash),
      false,
    ]).send(sendAs(deployerAddr)));
    console.log(`  Game deployed at: ${gameContract.address}`);

    await wallet.registerSender(gameContract.address, 'game-contract');

    // --- Register game contract on NFT ---
    console.log('Registering game contract on NFT...');
    await nftContract.methods
      .set_game_contract(gameContract.address)
      .send(sendAs(deployerAddr));
    // Starter cards come with 100 ARNA and settlement pays +20 each, so the NFT
    // and the token must know each other (same wiring as deploy-contracts.ts).
    await nftContract.methods.set_token_contract(tokenContract.address).send(sendAs(deployerAddr));
    await tokenContract.methods.set_nft_contract(nftContract.address).send(sendAs(deployerAddr));
    await tokenContract.methods.set_game_contract(gameContract.address).send(sendAs(deployerAddr));

    // --- Mint cards to players ---
    // Player 1: self-mint starter cards via get_cards_for_new_player
    // These use create_and_push_note (no tagging) so we MUST import notes after
    console.log('Minting cards to players...');
    console.log('  Player 1: calling get_cards_for_new_player (self-mint)...');
    const { receipt: p1MintReceipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p1Addr));
    console.log('  Player 1: starter cards minted, importing notes...');

    // Import Player 1's starter card notes (create_and_push_note skips tagging)
    {
      const { result: randomnessResult } = await nftContract.methods
        .compute_note_randomness(0, 5)
        .simulate({ from: p1Addr });
      const randomnessFrs = [];
      for (let i = 0; i < 5; i++) {
        randomnessFrs.push(toFr(randomnessResult[i]));
      }
      await importNotes(nftContract, node, p1MintReceipt.txHash, p1Addr, p1CardIds, randomnessFrs);
    }

    // Verify Player 1 notes are visible
    const { result: p1CardsArr } = await nftContract.methods
      .get_nfts_for_user(p1Addr, 0)
      .simulate({ from: p1Addr });
    const p1Cards = p1CardsArr[0];
    const p1Count = p1Cards.filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  Player 1: ${p1Count} notes visible after import`);
    if (p1Count < 5) {
      throw new Error(`Player 1 note import failed: only ${p1Count}/5 notes visible`);
    }

    // Player 2: also use get_cards_for_new_player (same flow as P1)
    // This mints starter cards [1,2,3,4,5] AND creates the note_nonce
    console.log('  Player 2: calling get_cards_for_new_player...');
    const { receipt: p2MintReceipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p2Addr));

    // Import P2's starter card notes (create_and_push_note skips tagging)
    {
      const { result: randomnessResult } = await nftContract.methods
        .compute_note_randomness(0, 5)
        .simulate({ from: p2Addr });
      const randomnessFrs = [];
      for (let i = 0; i < 5; i++) {
        randomnessFrs.push(toFr(randomnessResult[i]));
      }
      await importNotes(nftContract, node, p2MintReceipt.txHash, p2Addr, p2CardIds, randomnessFrs);
    }

    // Verify P2 notes
    const { result: p2CardsArr } = await nftContract.methods
      .get_nfts_for_user(p2Addr, 0)
      .simulate({ from: p2Addr });
    const p2Cards = p2CardsArr[0];
    const p2Count = p2Cards.filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  Player 2: ${p2Count} notes visible after import`);
    if (p2Count < 5) {
      throw new Error(`Player 2 note import failed: only ${p2Count}/5 notes visible`);
    }

    console.log('  All notes ready!');
  }, 600_000);

  afterAll(async () => {
    if (api) {
      try { await api.destroy(); } catch { /* ignore */ }
    }
  });

  // --------------------------------------------------------------------
  // Private-game helpers
  // --------------------------------------------------------------------

  const recordOf = (r: any[]) => r.map((v: any) => toFr(v));
  const ZERO_RECORD = () => new Array(9).fill(0).map(() => new Fr(0n));

  /** The game's siloed nullifiers (see game_nullifiers in the contract). */
  async function nullifiers(gameKey: any, r1: any[], r2: any[]) {
    const { result } = await gameContract.methods
      .game_nullifiers(gameKey, r1, r2)
      .simulate({ from: p1Addr });
    return (result as any[]).map(toFr);
  }

  /** Is this siloed nullifier on-chain? */
  async function exists(nullifier: any): Promise<boolean> {
    const { MerkleTreeId } = await import('@aztec-labs/stdlib/trees');
    const [found] = await node.findLeavesIndexes('latest', MerkleTreeId.NULLIFIER_TREE, [nullifier]);
    return found !== undefined;
  }

  async function nonceOf(addr: any): Promise<any> {
    const { result } = await nftContract.methods.get_note_nonce(addr).simulate({ from: addr });
    return toFr(result);
  }

  /** `[blinding, r_0..r_4, prize_randomness, reward_randomness]`. */
  async function secretsOf(addr: any, nonce: any): Promise<any[]> {
    const { result } = await nftContract.methods.compute_game_secrets(nonce).simulate({ from: addr });
    return (result as any[]).map(toFr);
  }

  async function cardsOf(addr: any): Promise<number[]> {
    const { result } = await nftContract.methods.get_nfts_for_user(addr, 0).simulate({ from: addr });
    return (result[0] as any[]).map((v: any) => Number(BigInt(v))).filter((v: number) => v !== 0).sort((a, b) => a - b);
  }

  async function tokensOf(addr: any): Promise<bigint> {
    const { result } = await tokenContract.methods.get_balance(addr).simulate({ from: addr });
    return BigInt(result);
  }

  /** Import one reward note, as importNotes does for cards. */
  async function importReward(txHash: any, owner: any, randomness: any) {
    const txResult = await node.getTxEffect(txHash);
    const txEffect = txResult.data;
    const hashes = (txEffect.noteHashes ?? []).map((h: any) => h.toString()).filter((h: string) => !/^0x0+$/.test(h));
    const padded = new Array(64).fill(new Fr(0n));
    hashes.forEach((h: string, i: number) => { padded[i] = toFr(h); });
    await tokenContract.methods
      .import_note(owner, 20n, randomness, toFr(txHash.toString()), padded, hashes.length, toFr(txEffect.nullifiers[0].toString()), owner)
      .simulate({ from: owner });
  }

  it('two players play a private game and settle it with nine real proofs', async () => {
    // The key the two players' key exchange would give them. Nothing else
    // about either player is ever handed to the other.
    const gameKey = Fr.random();

    // ================================================================
    // 1. Player 1 creates: preview the record, then commit
    // ================================================================
    const p1Nonce = await nonceOf(p1Addr);
    const { result: preview1 } = await gameContract.methods
      .preview_record(gameKey, p1CardIds.map((id) => new Fr(BigInt(id))), p1Nonce)
      .simulate({ from: p1Addr });
    const record1 = recordOf(preview1);
    await gameContract.methods
      .create_game(gameKey, p1CardIds.map((id) => new Fr(BigInt(id))))
      .send(sendAs(p1Addr));
    const [created] = await nullifiers(gameKey, record1, ZERO_RECORD());
    expect(await exists(created)).toBe(true);
    expect(await cardsOf(p1Addr)).toEqual([]);

    // ================================================================
    // 2. Player 2 joins with the key and player 1's record
    // ================================================================
    const p2Nonce = await nonceOf(p2Addr);
    const { result: preview2 } = await gameContract.methods
      .preview_record(gameKey, p2CardIds.map((id) => new Fr(BigInt(id))), p2Nonce)
      .simulate({ from: p2Addr });
    const record2 = recordOf(preview2);
    await gameContract.methods
      .join_game(gameKey, record1, p2CardIds.map((id) => new Fr(BigInt(id))))
      .send(sendAs(p2Addr));
    const all = await nullifiers(gameKey, record1, record2);
    expect(await exists(all[2])).toBe(true); // joined
    expect(await exists(all[3])).toBe(false); // not done

    // ================================================================
    // 3. Each player's own secrets; the hand commitments match on-chain
    // ================================================================
    const s1 = await secretsOf(p1Addr, p1Nonce);
    const s2 = await secretsOf(p2Addr, p2Nonce);
    const p1Commit = await computeCardCommit(api, p1CardIds, s1[0].toBigInt());
    const p2Commit = await computeCardCommit(api, p2CardIds, s2[0].toBigInt());
    expect(BigInt(p1Commit)).toBe(record1[1].toBigInt());
    expect(BigInt(p2Commit)).toBe(record2[1].toBigInt());

    // ================================================================
    // 4. Prove all nine moves
    // ================================================================
    console.log('Generating 9 move proofs...');
    const gameProofs = await generateFullGameProofs(
      api, gameMoveArtifact, p1CardIds, p2CardIds, toHex(s1[0]), toHex(s2[0]), p1Commit, p2Commit,
    );
    for (const p of gameProofs.moveProofs) expect(p.proofFields.length).toBe(proofLength);
    const winnerId = Number(gameProofs.moveInputs[8][5]);
    console.log(`  winner_id = ${winnerId}`);

    // The prize is the loser's first placed card: player 2 moves at odd
    // indices, player 1 at even ones.
    const prizeMove = winnerId === 1 ? 1 : 0;
    const prizeCard = Number(gameProofs.moveInputs[prizeMove][6]);
    const prizeSlot = Number(gameProofs.moveInputs[prizeMove][7]);

    // ================================================================
    // 5. Settle: nine real recursive proofs, records, prize move
    // ================================================================
    const settler = winnerId === 2 ? p2Addr : p1Addr;
    const args: any[] = [gameKey, record1, record2, realMoveVkFields];
    for (let i = 0; i < 9; i++) {
      args.push(gameProofs.moveProofs[i].proofFields.map(toFr));
      args.push(gameProofs.moveInputs[i].map(toFr));
    }
    args.push(new Fr(BigInt(prizeMove)));
    console.log('Calling settle_game...');
    const { receipt } = await gameContract.methods.settle_game(...args).send(sendAs(settler));
    expect(await exists(all[3])).toBe(true); // done

    // ================================================================
    // 6. Each player imports ONLY their own notes, from their own data
    // ================================================================
    const txHash = receipt.txHash;
    if (winnerId === 3) {
      await importNotes(nftContract, node, txHash, p1Addr, p1CardIds, s1.slice(1, 6));
      await importNotes(nftContract, node, txHash, p2Addr, p2CardIds, s2.slice(1, 6));
      expect(await cardsOf(p1Addr)).toEqual([...p1CardIds].sort());
      expect(await cardsOf(p2Addr)).toEqual([...p2CardIds].sort());
    } else {
      const [winner, loser] = winnerId === 1 ? [p1Addr, p2Addr] : [p2Addr, p1Addr];
      const [wIds, lIds] = winnerId === 1 ? [p1CardIds, p2CardIds] : [p2CardIds, p1CardIds];
      const [ws, ls] = winnerId === 1 ? [s1, s2] : [s2, s1];
      await importNotes(nftContract, node, txHash, winner, [...wIds, prizeCard], [...ws.slice(1, 6), ws[6]]);
      const kept = lIds.filter((_, i) => i !== prizeSlot);
      const keptRand = ls.slice(1, 6).filter((_, i) => i !== prizeSlot);
      await importNotes(nftContract, node, txHash, loser, kept, keptRand);
      expect(await cardsOf(winner)).toEqual([...wIds, prizeCard].sort((a, b) => a - b));
      expect(await cardsOf(loser)).toEqual([...kept].sort((a, b) => a - b));
    }
    await importReward(txHash, p1Addr, s1[7]);
    await importReward(txHash, p2Addr, s2[7]);
    // 100 from the starter claim, +20 for the game.
    expect(await tokensOf(p1Addr)).toBe(120n);
    expect(await tokensOf(p2Addr)).toBe(120n);

    // ================================================================
    // 7. A game settles once
    // ================================================================
    await expect(gameContract.methods.settle_game(...args).send(sendAs(settler))).rejects.toThrow();
  }, 1_800_000);
});
