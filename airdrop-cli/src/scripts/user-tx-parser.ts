import { BigNumber, ethers } from "ethers";
import { SupabaseClient, createClient } from "@supabase/supabase-js";
import { permit2Abi } from "../abis/permit2Abi";
import { writeFile } from "fs/promises";
import { formatUnits } from "viem";
import { Decoded, ScanResponse, User } from "../types";
import { SUPABASE_ANON_KEY, SUPABASE_URL, UBQ_OWNERS } from "../utils/constants";

/**
 * Collects permits using Etherscan and Gnosisscan APIs.
 * Does so using the tx history from three sources:
 * 1. Permit2 address: From === Hunter, To === Permit2
 * 2. UBQ wallet addresses: From === UBQ wallet, To === Hunter
 * 3. User wallet addresses: From === Hunter, To === Permit2
 *
 * All sources are combined, duplicates are removed
 * and the final result is written to a file.
 *
 * Outputs:
 * - blockscan-user-permits.json: A list of permits by wallet address.
 * - blockscan-leaderboard.json: A leaderboard of earnings by wallet address.
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
  userPermits: Record<string, Decoded[]> = {};
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

    // collect user info
    const { idToWalletMap } = await this.getSupabaseData();

    // collect wallet addresses
    const userWalletIds = this.users.map((user) => user.wallet_id);
    this.userWallets = userWalletIds.map((id) => idToWalletMap.get(id)?.toLowerCase());

    await this.batcher();

    await writeFile("src/scripts/data/user-tx-permits.json", JSON.stringify(this.userPermits, null, 2));
    await writeFile("src/scripts/data/user-sig-permits.json", JSON.stringify(this.userSigPermits, null, 2));

    // process all permits
    await this.leaderboard(this.userPermits);
    clearInterval(loader);

    console.log(`[UserBlockTxParser] Finished processing ${Object.keys(this.userPermits).length} users.`);
  }

  async leaderboard(data: Record<string, Decoded[]>) {
    const leaderboard: Record<string, number> = {};
    const userPermits = data;
    const users = Object.keys(userPermits);

    // calculate score for each user
    for (const user of users) {
      const permits = userPermits[user as keyof typeof userPermits];
      let score = 0;
      for (const permit of permits) {
        const amount = permit.permitted.amount;

        score += parseFloat(formatUnits(BigInt(amount), 18));
      }

      leaderboard[user] = score;
    }

    // sort leaderboard by score
    // reduce to object
    // write to file
    await writeFile(
      "src/scripts/data/user-tx-leaderboard.json",
      JSON.stringify(
        Object.entries(leaderboard)
          .sort((a, b) => b[1] - a[1])
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
        null,
        2
      )
    );
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
      gtxs = await this.getGnosisTxs(address);
      etxs = await this.getEthTxs(address);
    } else {
      for (const addr of address) {
        if (!addr) continue;

        const _gtxs = await this.getGnosisTxs(addr);
        const _etxs = await this.getEthTxs(addr);

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

      if (!this.userPermits[indexerAddress]) {
        this.userPermits[indexerAddress] = [];
      }

      this.userSigPermits[sig] = decoded;
      this.userPermits[indexerAddress].push(decoded);
    }
  }

  async getBlockNumbers() {
    const eth = await this.ethProvider.getBlockNumber();
    const gnosis = await this.gnosisProvider.getBlockNumber();

    return { eth, gnosis };
  }

  async getEthTxs(address: string, from?: number, to?: number, filter = true): Promise<ScanResponse[]> {
    const toBlock = to ?? (await this.getBlockNumbers()).eth;
    const fromBlock = from ?? 10373290; // ~3yrs ago 29/05/2024
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=${fromBlock}&endblock=${toBlock}&page=1&offset=1000&sort=asc&apikey=${this.etherscanApiKey}`;
    const response = await (await fetch(url)).json();
    const methodId = "0x30f28b7a";

    if (response.result === "Max rate limit reached") {
      console.log("Rate limit reached, waiting 3s before retrying...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return this.getEthTxs(address, from, to, filter);
    }

    if (!filter) return response.result as ScanResponse[];
    return response.result.filter((tx: ScanResponse) => tx.input.startsWith(methodId)) as ScanResponse[];
  }

  async getGnosisTxs(address: string, from?: number, to?: number, filter = true): Promise<ScanResponse[]> {
    const toBlock = to ?? (await this.getBlockNumbers()).gnosis;
    const fromBlock = from ?? 15349006; // ~3yrs ago 29/05/2024

    const url = `https://api.gnosisscan.io/api?module=account&action=txlist&address=${address}&startblock=${fromBlock}&endblock=${toBlock}&page=1&offset=1000&sort=asc&apikey=${this.gnosisApiKey}`;
    const response = await (await fetch(url)).json();
    const methodId = "0x30f28b7a";

    if (response.result === "Max rate limit reached") {
      console.log("Rate limit reached, waiting 3s before retrying...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return this.getGnosisTxs(address, from, to, filter);
    }

    if (!filter) return response.result as ScanResponse[];
    return response.result.filter((tx: ScanResponse) => tx.input.startsWith(methodId)) as ScanResponse[];
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

    this.users = users;

    return { walletToIdMap, idToWalletMap, users };
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
