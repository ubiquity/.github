import { ethers } from "ethers";
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
    const { earnings, permits } = await this.permitsAndEarnings(users, idToWalletMap);
    // pair addresses to nonces
    const addressToNoncesMap = await this.pairAddrToNonces(permits);

    await writeFile("src/scripts/data/dune-earnings.json", JSON.stringify(earnings, null, 2));
    await writeFile("src/scripts/data/dune-permits.json", JSON.stringify(permits, null, 2));
    await writeFile("src/scripts/data/dune-address-to-nonces.json", JSON.stringify(addressToNoncesMap, null, 2));

    clearInterval(loader);

    console.log(`[DuneDataParser] Finished processing ${users.length} users`);

    return { earnings, permits, addressToNoncesMap };
  }

  async permitsAndEarnings(users: User[], idToWalletMap: Map<number, string>) {
    const earnings: Record<string, number> = {};
    const permits: Record<
      string,
      ({
        date: string;
        decoded: Decoded | null;
        tx: Partial<ethers.providers.TransactionResponse>;
      } | null)[]
    > = {};

    for (const user of users) {
      // get wallet address
      const wallet = idToWalletMap.get(user.wallet_id)?.toLowerCase();
      if (!wallet) continue;

      // use wallet to get transactions
      const txs = await this.getUserTransactions(wallet);
      if (!txs || !txs.length) continue;

      // calculate total earned
      const totalEarned = txs.reduce((acc, tx) => {
        const { decoded } = tx;
        if (!decoded) return acc;

        let amount;

        // two forms somehow, so we try both
        amount = decoded.permitted?.amount.hex;
        if (!amount) amount = decoded.permitted?.amount._hex;

        const value = parseFloat(formatUnits(BigInt(amount?.toString() ?? "0"), 18));

        return acc + value;
      }, 0);

      console.log(`Total earned by ${wallet}: ${totalEarned}`);

      permits[wallet] = txs;
      earnings[wallet] = totalEarned;
    }

    return { earnings, permits };
  }

  async pairAddrToNonces(
    permits: Record<
      string,
      ({
        date: string;
        decoded: Decoded | null;
        tx: Partial<ethers.providers.TransactionResponse>;
      } | null)[]
    >
  ) {
    const addressToNoncesMap: Map<string, { nonce: string; date: string | undefined }[]> = new Map();

    // for each wallet, get the nonces from the permits
    for (const [wallet, txs] of Object.entries(permits)) {
      const nonces = txs
        .map((tx) => {
          // pull the decoded permit
          const decoded = tx?.decoded;
          if (!decoded) return null;

          // get the nonce
          const { nonce } = decoded;

          // return the nonce and date
          return { nonce, date: tx?.date };
        })
        // filter out nulls
        .filter((item) => item !== null) as { nonce: string; date: string }[];

      // assign the nonces to the wallet
      addressToNoncesMap.set(wallet, nonces);
    }

    return addressToNoncesMap;
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

    const txs: {
      tx: Partial<ethers.providers.TransactionResponse>;
      date: string;
      decoded: Decoded;
    }[] = [];

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

      const { data, hash, from, to, chainId, blockHash } = tx;
      let timestamp; // get timestamp from the chain the tx was on when it was mined

      if (blockHash && chainId === 1) {
        timestamp = (await this.ethProvider.getBlock(blockHash))?.timestamp;
      } else if (blockHash && chainId === 100) {
        timestamp = (await this.gnosisProvider.getBlock(blockHash))?.timestamp;
      }

      // decode permit data
      const decoded = this.decodePermit(data);

      txs.push({
        decoded,
        tx: { data, hash, timestamp, from, to },
        date: timestamp ? new Date(timestamp * 1000).toISOString() : "N/A",
      });
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
      walletToIdMap.set(wallet.address, wallet.id);
      idToWalletMap.set(wallet.id, wallet.address);
    }

    const { data: users, error: rr } = await this.sb.from("users").select("*").in("wallet_id", Array.from(idToWalletMap.keys()));

    if (rr || !users?.length) {
      console.error(rr);
      return { walletToIdMap, idToWalletMap, users: [] };
    }

    return { walletToIdMap, idToWalletMap, users };
  }

  decodePermit(data: ethers.utils.BytesLike): Decoded {
    const decodedData = this.permitDecoder.decodeFunctionData("permitTransferFrom", data);

    return {
      permitted: {
        token: decodedData[0][0].token,
        amount: decodedData[0][0].amount,
      },
      nonce: decodedData[3],
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

// main().finally(() => process.exit(0));
