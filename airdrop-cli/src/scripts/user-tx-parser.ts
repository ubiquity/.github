import { BigNumber, ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { Decoded, ScanResponse, User } from "../types";
import { PERMIT2_ADDRESS, UBQ_OWNERS } from "../utils/constants";
import { getSupabaseData, loader } from "./utils";
import { writeFile } from "fs/promises";
/**
 * Collects permits using Etherscan and Gnosisscan APIs.
 * Does so using the tx history from three sources:
 * 1. Permit2 address: From === Hunter, To === Permit2
 * 2. UBQ wallet addresses: From === UBQ wallet, To === Hunter
 * 3. User wallet addresses: From === Hunter, To === Permit2
 *
 * Middle ground of the three methods.
 */
export class UserBlockTxParser {
  gnosisApiKey: string;
  etherscanApiKey: string;
  permitDecoder: ethers.utils.Interface;
  ethProvider: ethers.providers.WebSocketProvider;
  gnosisProvider: ethers.providers.WebSocketProvider;
  userWallets: (string | undefined)[] = [];
  users: User[] = [];
  userSigPermits: Record<string, Decoded> = {};

  // cspell: disable-next-line
  constructor(gnosisApiKey = "WR9YP2CY3NG2WRX8FN5DCNKKIAGIIN83YN", etherscanApiKey = "JPHWVVUBAIP1UVQZSSDKV73YX48I2M7SWV") {
    this.gnosisApiKey = gnosisApiKey;
    this.etherscanApiKey = etherscanApiKey;
    this.permitDecoder = new ethers.utils.Interface(permit2Abi);
    this.gnosisProvider = new ethers.providers.WebSocketProvider("wss://rpc.gnosischain.com/wss", {
      name: "Gnosis Chain",
      chainId: 100,
      ensAddress: "",
    });

    this.ethProvider = new ethers.providers.WebSocketProvider("wss://mainnet.gateway.tenderly.co", {
      name: "Ethereum Mainnet",
      chainId: 1,
      ensAddress: "",
    });
  }

  async run() {
    const loader_ = loader();
    const { idToWalletMap, users } = await getSupabaseData();
    this.users = users;

    const userWalletIds = this.users.map((user) => user.wallet_id);
    this.userWallets = userWalletIds.map((id) => idToWalletMap.get(id)?.toLowerCase());

    await this.batcher();
    await writeFile("src/scripts/data/user-tx-sigs.json", JSON.stringify(this.userSigPermits, null, 2));
    console.log(`[UserBlockTxParser] Found ${Object.keys(this.userSigPermits).length} permits.`);
    clearInterval(loader_);
  }

  async batcher() {
    const batches = {
      permit2: PERMIT2_ADDRESS.toLowerCase(),
      owners: UBQ_OWNERS,
      users: this.userWallets,
    };

    for (const [target, batch] of Object.entries(batches)) {
      const shouldUseFrom = target === "permit2";
      console.log(`Processing ${target}...`);

      await this.processBatch(batch, shouldUseFrom);
    }
  }

  async processBatch(address: string | (string | undefined)[] | string[], from: boolean) {
    let gtxs: ScanResponse[] = [];
    let etxs: ScanResponse[] = [];

    if (!Array.isArray(address)) {
      gtxs = await this.getChainTx(address, undefined, undefined, true, 100);
      etxs = await this.getChainTx(address, undefined, undefined, true, 1);
    } else {
      for (const addr of address) {
        if (!addr) continue;

        const _gtxs = await this.getChainTx(addr, undefined, undefined, true, 100);
        const _etxs = await this.getChainTx(addr, undefined, undefined, true, 1);

        gtxs.push(..._gtxs);
        etxs.push(..._etxs);
      }
    }

    const permitLogs = [...gtxs, ...etxs];

    const indexer = from ? "from" : "to";

    for (const log of permitLogs) {
      const indexerAddress = log[indexer].toLowerCase();
      if (!this.userWallets.includes(indexerAddress)) continue;
      const decoded = this.decodePermit(log);
      const sig = decoded.reward.signature.toLowerCase();

      this.userSigPermits[sig] = decoded;
    }
  }

  async getBlockNumbers() {
    const eth = await this.ethProvider.getBlockNumber();
    const gnosis = await this.gnosisProvider.getBlockNumber();

    return { eth, gnosis };
  }

  async getChainTx(address: string, from?: number, to?: number, filter = true, chainId = 100): Promise<ScanResponse[]> {
    const chain = chainId === 1 ? "eth" : "gnosis";
    const toBlock = to ?? (await this.getBlockNumbers())[chain];
    const fromBlock = chain === "eth" ? 10373290 : 15349006; // ~3yrs ago 29/05/2024
    let response = { result: [] || "Max rate limit reached" };

    try {
      const scanEntity = chain === "eth" ? "etherscan" : "gnosisscan";
      const url = `https://api.${scanEntity}.io/api?module=account&action=txlist&address=${address}&startblock=${fromBlock}&endblock=${toBlock}&page=1&offset=1000&sort=asc&apikey=${chain === "eth" ? this.etherscanApiKey : this.gnosisApiKey
        }`;
      response = await (await fetch(url)).json();
    } catch (err) {
      console.error(err);
    }

    const methodId = "0x30f28b7a";

    if (typeof response.result === "string" && response.result === "Max rate limit reached") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return this.getChainTx(address, from, to, filter, chainId);
    }

    if (!filter) return response.result as ScanResponse[];
    return response.result.filter((tx: ScanResponse) => tx.input.startsWith(methodId)) as ScanResponse[];
  }

  decodePermit(data: ScanResponse): Decoded {
    const decodedData: ethers.utils.Result = this.permitDecoder.decodeFunctionData("permitTransferFrom", data.input);

    const token = decodedData[0][0][0];
    const to = decodedData[1][0];
    const amount = decodedData[1][1]?.hex ?? decodedData[1][1]?._hex;
    const owner = decodedData[2];
    const signature = decodedData[3];
    const nonce = decodedData[0][1];
    const deadline = decodedData[0][2];

    const strung = BigNumber.from(nonce).toString();

    return {
      blockTimestamp: data.timeStamp,
      txHash: data.hash,
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
//   const parser = new UserBlockTxParser();
//   await parser.run();
// }

// main()
//   .catch(console.error)
//   .finally(() => process.exit(0));
