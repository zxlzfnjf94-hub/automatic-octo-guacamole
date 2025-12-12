import fs from 'fs';
import { Wallet } from 'ethers';

const args = process.argv.slice(2);
const count = parseInt(args[0] || "1", 10);

if (isNaN(count) || count < 1) {
  console.error("Usage: node crypto-generator.js <count>");
  process.exit(1);
}

const wallets = [];
for (let i = 0; i < count; i++) {
  const w = Wallet.createRandom();
  wallets.push({
    address: w.address,
    private_key: w.privateKey
  });
}

fs.writeFileSync("wallets.json", JSON.stringify(wallets, null, 2));
console.log(`Generated ${count} wallet(s) saved in wallets.json`);
