import { BigNumber, ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { TX_HASHES } from "./tx-hashes";
import { Decoded, User } from "../types";
import { getSupabaseData, loader } from "./utils";
import { writeFile } from "fs/promises";

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
    const { idToWalletMap, users } = await getSupabaseData();
    await this.gatherPermits(users, idToWalletMap);

    clearInterval(loader_);

    await writeFile("src/scripts/data/dune-sigs.json", JSON.stringify(this.sigMap, null, 2));

    console.log(`[DuneDataParser] Finished processing ${users.length} users`);
  }

  async gatherPermits(users: User[], idToWalletMap: Map<number, string>) {
    for (const user of users) {
      const wallet = idToWalletMap.get(user.wallet_id)?.toLowerCase();
      if (!wallet) continue;

      const txs = await this.getUserTransactions(wallet);
      if (!txs || !txs.length) continue;

      txs.map((tx) => {
        if (!tx || !tx.reward) return;

        const sig = tx.reward.signature.toLowerCase();

        if (!this.sigMap[sig]) {
          this.sigMap[sig] = tx;
        }
      });
    }
  }

  async getUserTransactions(wallet: string) {
    if (!wallet) return null;
    console.info(`Processing wallet: ${wallet}`);

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
    let timestamp: number = 0;

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
    const deadline = decodedData[0][2];

    const strung = BigNumber.from(nonce).toString();

    return {
      blockTimestamp: new Date(timestamp * 1000),
      txHash: tx.hash,
      reward: {
        owner,
        permit: {
          deadline,
          nonce: strung,
          permitted: {
            amount,
            token,
          },
        },
        signature,
        transferDetails: {
          requestedAmount: amount,
          to,
        },
      },
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
