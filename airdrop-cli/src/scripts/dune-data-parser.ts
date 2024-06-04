import { BigNumber, ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { createClient } from "@supabase/supabase-js";
import { TX_HASHES } from "./tx-hashes";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../utils/constants";
import { Decoded, User } from "../types";
import { getSupabaseData, loader } from "./utils";

/**
 * Collects permits using tx hashes collected from Dune Analytics.
 * Hashes collected where "from" === Hunter address and "to" === Permit2 address.
 *
 * Least fruitful of the three methods.
 */

export class DuneDataParser {
  permitDecoder: ethers.utils.Interface;
  gnosisProvider: ethers.providers.WebSocketProvider;
  ethProvider: ethers.providers.WebSocketProvider;
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  sigMap: Record<string, Decoded> = {};

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
    const loader_ = loader();
    const { idToWalletMap, users } = await getSupabaseData(this.sb);
    await this.gatherPermits(users, idToWalletMap);

    clearInterval(loader_);

    console.log(`[DuneDataParser] Finished processing ${users.length} users`);
  }

  async gatherPermits(users: User[], idToWalletMap: Map<number, string>) {
    for (const user of users) {
      const wallet = idToWalletMap.get(user.wallet_id)?.toLowerCase();
      if (!wallet) continue;

      const txs = await this.getUserTransactions(wallet);
      if (!txs || !txs.length) continue;

      txs.map((tx) => {
        if (!tx || !tx.permitted) return;

        const sig = tx.signature.toLowerCase();

        if (!this.sigMap[sig]) {
          this.sigMap[sig] = tx;
        }
      });
    }
  }

  async getUserTransactions(wallet: string) {
    if (!wallet) return null;
    console.info(`Processing wallet: ${wallet}`);

    // using the txhashes collected using Dune Analytics
    const userTxHashes = TX_HASHES[wallet.toLowerCase()];
    let count = userTxHashes?.length;

    const txs: Decoded[] = [];
    if (!count) return null;

    while (count > 0) {
      const txHash = userTxHashes[count - 1];
      count--;
      let tx; // try Gnosis first as it's more common, then fallback to Ethereum
      tx = await this.gnosisProvider.getTransaction(txHash.hash);
      if (!tx) tx = await this.ethProvider.getTransaction(txHash.hash);
      if (!tx || !tx.data) continue;

      const decoded = await this.decodePermit(tx);
      txs.push(decoded);
    }

    return txs;
  }

  async decodePermit(tx: ethers.providers.TransactionResponse): Promise<Decoded> {
    const decodedData: ethers.utils.Result = this.permitDecoder.decodeFunctionData("permitTransferFrom", tx.data);

    const { blockHash, chainId } = tx;
    let timestamp;

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
}

// async function main() {
//   const parser = new DuneDataParser();
//   await parser.run();
// }

// main()
//   .catch(console.error)
//   .finally(() => process.exit(0));
