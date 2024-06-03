import { BigNumber, ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { createClient } from "@supabase/supabase-js";
import { TX_HASHES } from "./tx-hashes";
import { formatUnits } from "viem";
import { writeFile } from "fs/promises";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../utils/constants";
import { Decoded, User } from "../types";

/**
 * Collects permits using tx hashes collected from Dune Analytics.
 * Hashes collected where "from" === Permit2 address and "to" === Hunter address.
 *
 * The permits are then decoded and the nonces are paired with the wallet address.
 *
 * The earnings are calculated by summing the amounts from the permits.
 *
 * Outputs:
 * - dune-earnings.json: A leaderboard of earnings by wallet address.
 * - dune-permits.json: A list of permits by wallet address.
 * - dune-address-to-nonces.json: A list of nonces by wallet address.
 *
 * Least fruitful of the three methods.
 */

export class DuneDataParser {
  permitDecoder: ethers.utils.Interface;
  gnosisProvider: ethers.providers.WebSocketProvider;
  ethProvider: ethers.providers.WebSocketProvider;
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  constructor() {
    this.permitDecoder = new ethers.utils.Interface(permit2Abi);
    this.gnosisProvider = new ethers.providers.WebSocketProvider("wss://gnosis-rpc.publicnode.com", {
      name: "Gnosis Chain",
      chainId: 100,
      ensAddress: "",
    });

    this.ethProvider = new ethers.providers.WebSocketProvider("wss://ethereum-rpc.publicnode.com", {
      name: "Ethereum Mainnet",
      chainId: 1,
      ensAddress: "",
    });
  }

  async run() {
    const loader = this.loader();

    // collect user info
    const { idToWalletMap, users } = await this.getSupabaseData();
    // collect earnings and permits
    const { earnings, permits, sigMap } = await this.permitsAndEarnings(users, idToWalletMap);
    // pair addresses to nonces

    await writeFile("src/scripts/data/dune-earnings.json", JSON.stringify(earnings, null, 2));
    await writeFile("src/scripts/data/dune-permits.json", JSON.stringify(permits, null, 2));
    await writeFile("src/scripts/data/dune-sig-map.json", JSON.stringify(sigMap, null, 2));

    clearInterval(loader);

    console.log(`[DuneDataParser] Finished processing ${users.length} users`);

    return { earnings, permits, sigMap };
  }

  async permitsAndEarnings(users: User[], idToWalletMap: Map<number, string>) {
    const earnings: Record<string, number> = {};
    const permits: Record<string, Decoded[]> = {};
    const sigMap: Record<string, Decoded> = {};

    for (const user of users) {
      // get wallet address
      const wallet = idToWalletMap.get(user.wallet_id)?.toLowerCase();
      if (!wallet) continue;

      // use wallet to get transactions
      const txs = await this.getUserTransactions(wallet);
      if (!txs || !txs.length) continue;

      // calculate total earned
      const totalEarned = txs.reduce((acc, tx) => {
        if (!tx || !tx.permitted) return acc;

        const sig = tx.signature;

        if (!sigMap[sig]) sigMap[sig] = tx;

        const value = parseFloat(formatUnits(BigInt(tx.permitted.amount), 18));

        return acc + value;
      }, 0);

      console.log(`Total earned by ${wallet}: ${totalEarned}`);

      permits[wallet] = txs;
      earnings[wallet] = totalEarned;
    }

    return { earnings, permits, sigMap };
  }

  async getUserTransactions(wallet: string) {
    if (!wallet) {
      console.error("No wallet provided");
      return null;
    }
    console.info(`Processing wallet: ${wallet}`);

    // using the txhashes collected using Dune Analytics
    const userTxHashes = TX_HASHES[wallet.toLowerCase()];
    let count = userTxHashes?.length;

    const txs: Decoded[] = [];

    if (!count) {
      console.error("No tx hashes found for wallet");
      return null;
    }

    // loop through tx hashes and get the data
    while (count > 0) {
      const txHash = userTxHashes[count - 1];
      count--;
      let tx; // try Gnosis first as it's more common, then fallback to Ethereum
      tx = await this.gnosisProvider.getTransaction(txHash.hash);
      if (!tx) tx = await this.ethProvider.getTransaction(txHash.hash);
      if (!tx || !tx.data) continue;

      // decode permit data
      const decoded = await this.decodePermit(tx);

      txs.push(decoded);
    }

    return txs;
  }

  async getSupabaseData(): Promise<{ walletToIdMap: Map<string, number>; idToWalletMap: Map<number, string>; users: User[] }> {
    const walletToIdMap = new Map<string, number>();
    const idToWalletMap = new Map<number, string>();

    const { data, error } = await this.sb.from("wallets").select("address, id");

    if (error || !data?.length) {
      console.error(error);
      return { walletToIdMap, idToWalletMap, users: [] };
    }

    for (const wallet of data) {
      const addr = wallet.address.toLowerCase();
      walletToIdMap.set(addr, wallet.id);
      idToWalletMap.set(wallet.id, addr);
    }

    const { data: users, error: rr } = await this.sb.from("users").select("*").in("wallet_id", Array.from(idToWalletMap.keys()));

    if (rr || !users?.length) {
      console.error(rr);
      return { walletToIdMap, idToWalletMap, users: [] };
    }

    return { walletToIdMap, idToWalletMap, users };
  }

  async decodePermit(tx: ethers.providers.TransactionResponse): Promise<Decoded> {
    const decodedData: ethers.utils.Result = this.permitDecoder.decodeFunctionData("permitTransferFrom", tx.data);

    const { blockHash, chainId } = tx;
    let timestamp; // get timestamp from the chain the tx was on when it was mined

    if (blockHash && chainId === 1) {
      timestamp = (await this.ethProvider.getBlock(blockHash))?.timestamp;
    } else if (blockHash && chainId === 100) {
      timestamp = (await this.gnosisProvider.getBlock(blockHash))?.timestamp;
    }

    const token = decodedData[0][0][0];
    const to = decodedData[1][0];
    const amount = decodedData[1][1]?.hex ?? decodedData[1][1]?._hex;
    const owner = decodedData[2];
    const signature = decodedData[3];
    const nonce = decodedData[0][1];

    return {
      nonce: BigNumber.from(nonce).toString().toLowerCase(),
      signature,
      permitOwner: owner,
      to,
      permitted: {
        amount,
        token,
      },
      txHash: tx.hash,
      blockTimestamp: new Date((timestamp ?? 0) * 1000),
    };
  }

  loader() {
    const steps = ["|", "/", "-", "\\"];
    let i = 0;
    return setInterval(() => {
      process.stdout.write(`\r${steps[i++]}`);
      i = i % steps.length;
    }, 100);
  }
}

// async function main() {
//   const parser = new DuneDataParser();
//   await parser.run();
// }

// main()
//   .catch(console.error)
//   .finally(() => process.exit(0));
