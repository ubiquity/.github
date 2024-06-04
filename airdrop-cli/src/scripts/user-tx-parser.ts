import { BigNumber, ethers } from "ethers";
import { SupabaseClient, createClient } from "@supabase/supabase-js";
import { permit2Abi } from "../abis/permit2Abi";
import { Decoded, ScanResponse, User } from "../types";
import { SUPABASE_ANON_KEY, SUPABASE_URL, UBQ_OWNERS } from "../utils/constants";
import { getSupabaseData } from "./utils";
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
  sb: SupabaseClient;
  ethProvider: ethers.providers.WebSocketProvider;
  gnosisProvider: ethers.providers.WebSocketProvider;
  userWallets: (string | undefined)[] = [];
  users: User[] = [];
  userSigPermits: Record<string, Decoded> = {};

  constructor(gnosisApiKey = "WR9YP2CY3NG2WRX8FN5DCNKKIAGIIN83YN", etherscanApiKey = "JPHWVVUBAIP1UVQZSSDKV73YX48I2M7SWV") {
    this.gnosisApiKey = gnosisApiKey;
    this.etherscanApiKey = etherscanApiKey;
    this.permitDecoder = new ethers.utils.Interface(permit2Abi);
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
    const { idToWalletMap, users } = await getSupabaseData(this.sb);
    this.users = users;

    const userWalletIds = this.users.map((user) => user.wallet_id);
    this.userWallets = userWalletIds.map((id) => idToWalletMap.get(id)?.toLowerCase());

    await this.batcher();
    clearInterval(loader);
  }

  async batcher() {
    const batches = {
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3".toLowerCase(),
      // previous and current UBQ wallet addresses
      owners: UBQ_OWNERS,
      users: this.userWallets,
    };

    for (const [target, batch] of Object.entries(batches)) {
      const shouldUseFrom = target === "permit2";

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
      const sig = decoded.signature.toLowerCase();

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
    const url = `https://api.${chain}.io/api?module=account&action=txlist&address=${address}&startblock=${fromBlock}&endblock=${toBlock}&page=1&offset=1000&sort=asc&apikey=${this.etherscanApiKey}`;
    const response = await (await fetch(url)).json();
    const methodId = "0x30f28b7a";

    if (response.result === "Max rate limit reached") {
      console.log("Rate limit reached, waiting 3s before retrying...");
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

    const strung = BigNumber.from(nonce).toString();

    return {
      nonce: strung,
      signature,
      permitOwner: owner,
      to,
      permitted: {
        amount,
        token,
      },
      txHash: data.hash,
      blockTimestamp: new Date(parseInt(data.timeStamp) * 1000),
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
//   const parser = new UserBlockTxParser();
//   await parser.run();
// }

// main()
//   .catch(console.error)
//   .finally(() => process.exit(0));
