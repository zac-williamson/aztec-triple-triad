/**
 * Browser-side script that mirrors the EXACT client-side transaction flow:
 *
 * 1. EmbeddedWallet.create() (browser entrypoint → IndexedDB)
 * 2. Register SponsoredFPC
 * 3. Deploy Schnorr account
 * 4. Register NFT + Game contracts with PXE (wallet.registerContract)
 * 5. Mint starter cards via get_cards_for_new_player().send()
 * 6. compute_note_randomness().simulate()
 * 7. importNotesFromTx (5x import_note().simulate())
 * 8. get_private_cards().simulate() (paginated card fetch)
 * 9. warmupContracts (fire-and-forget Contract.at() x2)
 * 10. createGameOnChain pipeline:
 *     a. get_note_nonce().simulate()
 *     b. preview_game_data().simulate()
 *     c. get_game_status().simulate()
 *     d. compute_blinding_factor().simulate()
 *     e. get_private_cards().simulate() (diagnostic)
 *     f. create_game().send()  ← THE CALL THAT FAILS
 *
 * This is served by the frontend Vite dev server and opened by Playwright.
 */

const log = (msg: string) => {
  const el = document.getElementById('log');
  if (el) el.textContent += '\n' + msg;
  console.log('[idb-test]', msg);
};

const PXE_URL = 'http://localhost:8080';
const NFT_ADDR = (import.meta as any).env?.VITE_NFT_CONTRACT_ADDRESS || '';
const GAME_ADDR = (import.meta as any).env?.VITE_GAME_CONTRACT_ADDRESS || '';
const SEND_TIMEOUT = 300;

async function run() {
  try {
    log('Step 1: Importing Aztec SDK...');
    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
    const { GrumpkinScalar } = await import('@aztec/foundation/curves/grumpkin');
    const { Fr } = await import('@aztec/aztec.js/fields');
    const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee');
    const { SponsoredFPCContractArtifact } = await import('@aztec/noir-contracts.js/SponsoredFPC');
    const { SPONSORED_FPC_SALT } = await import('@aztec/constants');
    const { getContractInstanceFromInstantiationParams } = await import('@aztec/stdlib/contract');
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');
    const { Contract } = await import('@aztec/aztec.js/contracts');
    const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
    const { NO_FROM } = await import('@aztec/aztec.js/account');

    const toFr = (v: any) => {
      const s = v.toString();
      if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
      return new Fr(BigInt(s));
    };
    const toHex = (v: any) => {
      const s = v.toString();
      if (s.startsWith('0x') || s.startsWith('0X')) return s;
      return '0x' + BigInt(s).toString(16);
    };
    const sendAs = (addr: any) => ({
      from: addr,
      fee: { paymentMethod: fee },
      wait: { timeout: SEND_TIMEOUT },
    });

    // ── Step 2: Connect to node ──
    log('Step 2: Connecting to Aztec node...');
    const node = createAztecNodeClient(PXE_URL);
    for (let i = 0; i < 60; i++) {
      try { if (await node.getBlockNumber() > 0) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── Step 3: Create EmbeddedWallet (browser IndexedDB) ──
    log('Step 3: Creating EmbeddedWallet (IndexedDB backend)...');
    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    log('  Wallet created. Waiting for PXE sync...');
    await new Promise(r => setTimeout(r, 5000));

    // ── Step 4: Register SponsoredFPC ──
    log('Step 4: Registering SponsoredFPC...');
    const sponsoredFPC = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
    var fee = new SponsoredFeePaymentMethod(sponsoredFPC.address);

    // ── Step 5: Deploy account ──
    log('Step 5: Deploying Schnorr account...');
    const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await account.getDeployMethod()).send({
      from: NO_FROM,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    const addr = account.address;
    await wallet.registerSender(addr, 'player');
    log(`  Account: ${addr}`);

    // ── Step 6: Register NFT + Game contracts (exactly as useAztec does) ──
    log('Step 6: Registering NFT + Game contracts with PXE...');
    if (!NFT_ADDR || !GAME_ADDR) throw new Error('Contract addresses not configured');

    const nftAddress = AztecAddress.fromString(NFT_ADDR);
    const gameAddress = AztecAddress.fromString(GAME_ADDR);

    await wallet.registerSender(nftAddress, 'nft-contract');
    const nftInstance = await node.getContract(nftAddress);
    if (!nftInstance) throw new Error('NFT contract not found on node');
    const nftResp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
    const nftArtifact = loadContractArtifact(await nftResp.json());
    await wallet.registerContract(nftInstance, nftArtifact);
    log('  NFT contract registered');

    await wallet.registerSender(gameAddress, 'game-contract');
    const gameInstance = await node.getContract(gameAddress);
    if (!gameInstance) throw new Error('Game contract not found on node');
    const gameResp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
    const gameArtifact = loadContractArtifact(await gameResp.json());
    await wallet.registerContract(gameInstance, gameArtifact);
    log('  Game contract registered');

    // ── Step 7: Mint starter cards (get_cards_for_new_player().send()) ──
    log('Step 7: Minting starter cards...');
    const nftContract = await Contract.at(nftAddress, nftArtifact, wallet as any);
    const gameContract = await Contract.at(gameAddress, gameArtifact, wallet as any);

    const { receipt: mintReceipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(addr));
    log(`  Starter cards minted: ${mintReceipt.txHash}`);

    // ── Step 8: compute_note_randomness().simulate() ──
    log('Step 8: Computing note randomness...');
    const { result: randomnessResult } = await nftContract.methods
      .compute_note_randomness(0, 5)
      .simulate({ from: addr });

    // ── Step 9: Import notes (5x import_note().simulate()) ──
    log('Step 9: Importing 5 notes...');
    const { TxHash } = await import('@aztec/stdlib/tx');
    const txHash = TxHash.fromString(mintReceipt.txHash.toString());

    let txEffect: any = null;
    for (let i = 0; i < 10; i++) {
      try {
        const r = await node.getTxEffect(txHash);
        if (r?.data) { txEffect = r.data; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

    if (txEffect) {
      const noteHashes = (txEffect.noteHashes || [])
        .map((h: any) => h.toString())
        .filter((h: string) => !/^0x0+$/.test(h) && h !== '0');
      const firstNull = txEffect.nullifiers?.[0]?.toString() ?? '0';
      const padded = new Array(64).fill(new Fr(0n));
      for (let i = 0; i < noteHashes.length && i < 64; i++) {
        padded[i] = toFr(noteHashes[i]);
      }
      for (let i = 0; i < 5; i++) {
        await nftContract.methods
          .import_note(addr, new Fr(BigInt(i + 1)), toFr(randomnessResult[i]),
            toFr(mintReceipt.txHash.toString()), padded, noteHashes.length,
            toFr(firstNull), addr)
          .simulate({ from: addr });
        log(`  Imported note for card ${i + 1}`);
      }
    } else {
      log('  WARNING: Could not fetch TxEffect');
    }

    // ── Step 10: get_private_cards().simulate() (paginated card fetch) ──
    log('Step 10: Fetching owned cards...');
    const { result: cardsResult } = await nftContract.methods
      .get_private_cards(addr, 0)
      .simulate({ from: addr });
    const count = cardsResult[0].filter((v: any) => BigInt(v) !== 0n).length;
    log(`  Cards visible: ${count}/5`);
    if (count < 5) throw new Error(`Only ${count}/5 cards visible`);

    // ── Step 11: warmupContracts (fire-and-forget, mirrors useGame.ts line 401) ──
    // In the app, this calls ensureContracts() which does Contract.at() x2.
    // Here the contracts are already cached, so this is a no-op — same as the app
    // after the first warmup completes.
    log('Step 11: Warmup contracts (already cached, same as app)...');

    // ── Step 12: createGameOnChain pipeline (mirrors useGame.ts lines 197-278) ──
    log('Step 12: createGameOnChain pipeline...');

    // 12a: get_note_nonce
    log('  12a: get_note_nonce().simulate()...');
    const { result: nonceResult } = await nftContract.methods
      .get_note_nonce(addr)
      .simulate({ from: addr });
    log(`  Nonce: ${nonceResult}`);

    // 12b: preview_game_data
    log('  12b: preview_game_data().simulate()...');
    const { result: previewResult } = await nftContract.methods
      .preview_game_data(toFr(nonceResult))
      .simulate({ from: addr });
    const gameIdHex = toHex(previewResult[0]);
    log(`  Game ID: ${gameIdHex.slice(0, 20)}...`);

    // 12c: get_game_status
    log('  12c: get_game_status().simulate()...');
    const { result: statusResult } = await gameContract.methods
      .get_game_status(toFr(gameIdHex))
      .simulate({ from: addr });
    log(`  Status: ${statusResult} (expect 0)`);

    // 12d: compute_blinding_factor
    log('  12d: compute_blinding_factor().simulate()...');
    const { result: blindingResult } = await nftContract.methods
      .compute_blinding_factor(toFr(gameIdHex))
      .simulate({ from: addr });
    log(`  Blinding factor: ${toHex(blindingResult).slice(0, 20)}...`);

    // 12e: get_private_cards (diagnostic)
    log('  12e: get_private_cards().simulate() (diagnostic)...');
    await nftContract.methods.get_private_cards(addr, 0).simulate({ from: addr });

    // 12f: create_game().send() — THE CALL THAT FAILS IN THE APP
    log('  12f: create_game().send() — THIS IS THE CRITICAL CALL');
    log('  (6 nullifiers + 6 notes, cross-contract call)');

    const t0 = performance.now();
    try {
      await gameContract.methods
        .create_game([1, 2, 3, 4, 5].map(id => new Fr(BigInt(id))))
        .send(sendAs(addr));

      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      log(`\ncreate_game SUCCEEDED in ${elapsed}s`);
      (window as any).__IDB_TEST_RESULT__ = { success: true, elapsed };
    } catch (err: any) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      log(`\ncreate_game FAILED after ${elapsed}s: ${err.message}`);
      (window as any).__IDB_TEST_RESULT__ = {
        success: false,
        error: err.message,
        name: err.name,
        isTransactionInactiveError:
          err.message?.includes('TransactionInactiveError') ||
          err.message?.includes('transaction is inactive or finished') ||
          err.name === 'TransactionInactiveError',
      };
    }
  } catch (err: any) {
    log(`SETUP ERROR: ${err.message}`);
    (window as any).__IDB_TEST_RESULT__ = { error: err.message, setup: true };
  }
}

run();
