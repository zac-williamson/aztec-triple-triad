import { BotChain } from '../src/BotChain.js';
const idx = Number(process.argv[2] ?? '0');
const chain = new BotChain({
  pxeUrl: process.env.AZTEC_PXE_URL ?? 'http://localhost:8080',
  nftAddress: process.env.VITE_NFT_CONTRACT_ADDRESS!,
  gameAddress: process.env.VITE_GAME_CONTRACT_ADDRESS!,
  tokenAddress: process.env.VITE_TOKEN_CONTRACT_ADDRESS,
  manifestPath: `packages/bot/.artifacts/arena-bot-${idx}.json`,
}, m => console.log(`[chain${idx}] ${m}`));
async function main() {
  await chain.connect();
  const cards = await chain.readCards();
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  console.log(`SPENDABLE_TOTAL=${cards.length} TYPES=${counts.size}`);
  console.log('BY_TYPE=' + JSON.stringify([...counts.entries()].sort((a, b) => a[0] - b[0])));
  console.log('HAND=' + JSON.stringify(await chain.selectHand(5)));
  process.exit(0);
}
void main();
