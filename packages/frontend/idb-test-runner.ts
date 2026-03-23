/**
 * Browser-side script for reproducing the TransactionInactiveError.
 *
 * This runs in a real browser with real IndexedDB. It exercises the exact
 * same code path as the game: EmbeddedWallet (browser entrypoint → IndexedDB),
 * deploy account, mint cards, then create_game().send().
 *
 * Served by the frontend's Vite dev server (which provides COOP/COEP headers,
 * node polyfills, and WASM support). Opened by a Playwright test.
 */

const log = (msg: string) => {
  const el = document.getElementById('log');
  if (el) el.textContent += '\n' + msg;
  console.log('[idb-test]', msg);
};

const PXE_URL = 'http://localhost:8080';
const NFT_ADDR = (import.meta as any).env?.VITE_NFT_CONTRACT_ADDRESS || '';
const GAME_ADDR = (import.meta as any).env?.VITE_GAME_CONTRACT_ADDRESS || '';

async function run() {
  try {
    log('Importing Aztec SDK...');
    const [
      { createAztecNodeClient },
      { EmbeddedWallet },
      { GrumpkinScalar },
      { Fr },
      { SponsoredFeePaymentMethod },
      { SponsoredFPCContractArtifact },
      { SPONSORED_FPC_SALT },
      { getContractInstanceFromInstantiationParams },
      { AztecAddress },
      { Contract },
      { loadContractArtifact },
      { NO_FROM },
    ] = await Promise.all([
      import('@aztec/aztec.js/node'),
      import('@aztec/wallets/embedded'),
      import('@aztec/foundation/curves/grumpkin'),
      import('@aztec/aztec.js/fields'),
      import('@aztec/aztec.js/fee'),
      import('@aztec/noir-contracts.js/SponsoredFPC'),
      import('@aztec/constants'),
      import('@aztec/stdlib/contract'),
      import('@aztec/aztec.js/addresses'),
      import('@aztec/aztec.js/contracts'),
      import('@aztec/aztec.js/abi'),
      import('@aztec/aztec.js/account'),
    ]);

    const toFr = (v: any) => {
      const s = v.toString();
      if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
      return new Fr(BigInt(s));
    };

    log('Connecting to Aztec node...');
    const node = createAztecNodeClient(PXE_URL);

    // Wait for node
    for (let i = 0; i < 60; i++) {
      try {
        if (await node.getBlockNumber() > 0) break;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    log('Creating EmbeddedWallet (browser IndexedDB backend)...');
    const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    log('Wallet created. Waiting for PXE sync...');
    await new Promise(r => setTimeout(r, 5000));

    // Register SponsoredFPC
    const sponsoredFPC = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact,
      { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
    const fee = new SponsoredFeePaymentMethod(sponsoredFPC.address);
    const sendAs = (addr: any) => ({
      from: addr,
      fee: { paymentMethod: fee },
      wait: { timeout: 300 },
    });

    log('Deploying account...');
    const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await account.getDeployMethod()).send({
      from: NO_FROM,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: 300 },
    });
    const addr = account.address;
    await wallet.registerSender(addr, 'player');
    log(`Account deployed: ${addr}`);

    // Register contracts
    if (!NFT_ADDR || !GAME_ADDR) {
      log('ERROR: VITE_NFT_CONTRACT_ADDRESS or VITE_GAME_CONTRACT_ADDRESS not set');
      (window as any).__IDB_TEST_RESULT__ = { error: 'Missing contract addresses' };
      return;
    }

    log('Registering contracts with PXE...');

    // Fetch contract instances from the node (they're already deployed)
    const nftAddress = AztecAddress.fromString(NFT_ADDR);
    const gameAddress = AztecAddress.fromString(GAME_ADDR);

    const nftInstance = await node.getContract(nftAddress);
    const gameInstance = await node.getContract(gameAddress);
    if (!nftInstance) throw new Error('NFT contract not found on node');
    if (!gameInstance) throw new Error('Game contract not found on node');

    // Load artifacts and register with PXE
    const nftResp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
    const nftArtifact = loadContractArtifact(await nftResp.json());
    await wallet.registerContract(nftInstance, nftArtifact);
    await wallet.registerSender(nftAddress, 'nft');

    const gameResp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
    const gameArtifact = loadContractArtifact(await gameResp.json());
    await wallet.registerContract(gameInstance, gameArtifact);
    await wallet.registerSender(gameAddress, 'game');

    const nftContract = await Contract.at(nftAddress, nftArtifact, wallet as any);
    const gameContract = await Contract.at(gameAddress, gameArtifact, wallet as any);
    log('Contracts registered.');

    // Mint starter cards
    log('Minting starter cards...');
    const { receipt: mintReceipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(addr));
    log(`Starter cards minted: ${mintReceipt.txHash}`);

    // Import notes
    log('Importing notes...');
    const { result: randomnessResult } = await nftContract.methods
      .compute_note_randomness(0, 5)
      .simulate({ from: addr });

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
        padded[i] = Fr.fromHexString(noteHashes[i].startsWith('0x') ? noteHashes[i] : '0x' + BigInt(noteHashes[i]).toString(16));
      }

      const toFr = (v: any) => {
        const s = v.toString();
        return s.startsWith('0x') ? Fr.fromHexString(s) : new Fr(BigInt(s));
      };

      for (let i = 0; i < 5; i++) {
        try {
          await nftContract.methods
            .import_note(addr, new Fr(BigInt(i + 1)), toFr(randomnessResult[i]),
              toFr(mintReceipt.txHash.toString()), padded, noteHashes.length,
              toFr(firstNull), addr)
            .simulate({ from: addr });
        } catch (e: any) {
          log(`  import_note ${i + 1} failed: ${e.message?.slice(0, 80)}`);
        }
      }
      log('Notes imported.');
    } else {
      log('WARNING: Could not fetch TxEffect for note import');
    }

    // Verify cards
    const { result: cards } = await nftContract.methods
      .get_private_cards(addr, 0)
      .simulate({ from: addr });
    const count = cards[0].filter((v: any) => BigInt(v) !== 0n).length;
    log(`Cards visible: ${count}/5`);

    if (count < 5) {
      log('ERROR: Not enough cards visible');
      (window as any).__IDB_TEST_RESULT__ = { error: 'Not enough cards' };
      return;
    }

    // Preview game data
    const { result: nonce } = await nftContract.methods
      .get_note_nonce(addr)
      .simulate({ from: addr });
    const { result: preview } = await nftContract.methods
      .preview_game_data(toFr(nonce))
      .simulate({ from: addr });
    const gameIdHex = '0x' + BigInt(preview[0]).toString(16);
    log(`Game ID: ${gameIdHex.slice(0, 20)}...`);

    // THE CRITICAL CALL
    log('=== Calling create_game().send() ===');
    log('This generates 6 nullifiers + 6 notes in a cross-contract call.');
    log('In browser IndexedDB, this triggers TransactionInactiveError.');

    const t0 = performance.now();
    try {
      await gameContract.methods
        .create_game([1, 2, 3, 4, 5].map(id => new Fr(BigInt(id))))
        .send(sendAs(addr));

      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      log(`create_game SUCCEEDED in ${elapsed}s`);
      (window as any).__IDB_TEST_RESULT__ = { success: true, elapsed };
    } catch (err: any) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      log(`create_game FAILED after ${elapsed}s: ${err.message}`);
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
