import { ethers } from "ethers";
import { SupabaseClient, createClient } from "@supabase/supabase-js";
import { permit2Abi } from "../abis/permit2Abi";
import { writeFile } from "fs/promises";
import { formatUnits } from "viem";
import { Decoded, User } from "../types";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../utils/constants";

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
  ethProvider: ethers.providers.JsonRpcProvider;
  gnosisProvider: ethers.providers.JsonRpcProvider;

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
    const { idToWalletMap, users } = await this.getSupabaseData();

    // previous and current UBQ wallet addresses
    const owners = [
      "0xf87ca4583C792212e52720d127E7E0A38B818aD1".toLowerCase(),
      "0x44Ca15Db101fD1c194467Db6AF0c67C6BbF4AB51".toLowerCase(),
      "0x816863778F0Ea481E00195606B50d91F7C64637c".toLowerCase(),
      "0x70fbcF82ffa891C4267B77847c21243c566f7617".toLowerCase(),
    ];

    // collect wallet addresses
    const userWalletIds = users.map((user) => user.wallet_id);
    const userWallets = userWalletIds.map((id) => idToWalletMap.get(id)?.toLowerCase());

    const userPermitSet: Record<string, Set<Decoded>> = {};

    // process tx history using permit2 as the source
    const permit2TxHistoryPermits = await this.processPermit2(userWallets);

    // process tx history using UBQ wallet addressses as the source
    const ownerTxHistoryPermits = await this.processOwners(userWallets, owners);

    // process tx history using user wallet addresses as the source
    const userTxHistoryPermits = await this.processUsers(idToWalletMap, users);

    // combine permits from all sources
    const userPermits: Record<string, Decoded[]> = { ...permit2TxHistoryPermits, ...ownerTxHistoryPermits, ...userTxHistoryPermits };

    for (const user of Object.keys(userPermits)) {
      // collect just the user's permits
      const permits = userPermits[user as keyof typeof userPermits];

      for (const permit of permits) {
        if (!userPermitSet[user]) {
          userPermitSet[user] = new Set();
        }

        // add permit to user's set, to avoid duplicates
        userPermitSet[user].add(permit);
      }
    }

    // convert userPermitSet to userPermitArray
    const userPermitArray: Record<string, Decoded[]> = {};

    for (const user of Object.keys(userPermitSet)) {
      userPermitArray[user] = Array.from(userPermitSet[user]);
    }

    await writeFile("src/scripts/data/blockscan-user-permits.json", JSON.stringify(userPermitArray, null, 2));

    // process all permits
    await this.leaderboard(userPermitArray);
    clearInterval(loader);

    console.log(`[UserBlockTxParser] Finished processing ${Object.keys(userPermitArray).length} users.`);

    return userPermitArray;
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
        let amount = permit.permitted.amount.hex;

        if (!amount) amount = permit.permitted.amount._hex;
        if (!amount) continue;

        score += parseFloat(formatUnits(BigInt(amount), 18));
      }

      leaderboard[user] = score;
    }

    // sort leaderboard by score
    // reduce to object
    // write to file
    await writeFile(
      "src/scripts/data/blockscan-leaderboard.json",
      JSON.stringify(
        Object.entries(leaderboard)
          .sort((a, b) => b[1] - a[1])
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
        null,
        2
      )
    );
  }

  async processPermit2(userWallets: (string | undefined)[]): Promise<Record<string, Decoded[]>> {
    const userPermits: Record<string, Decoded[]> = {};
    const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const methodId = "0x30f28b7a";

    const gtxs = await this.getGnosisTxs(permit2);
    const etxs = await this.getEthTxs(permit2);

    const gnosisPermitLogs = gtxs.result.filter((tx: { input: string }) => tx.input.startsWith(methodId));
    const ethPermitLogs = etxs.result.filter((tx: { input: string }) => tx.input.startsWith(methodId));

    const permitLogs = [...gnosisPermitLogs, ...ethPermitLogs];

    for (const log of permitLogs) {
      // from hunter to permit2 using permit2 tx history
      const from = log.from.toLowerCase();
      if (!userWallets.includes(from)) continue;
      const decoded = this.decodePermit(log.input);
      decoded.txHash = log.hash;

      if (!userPermits[from]) {
        userPermits[from] = [];
      }

      userPermits[from].push(decoded);
    }

    return userPermits;
  }

  async processOwners(userWallets: (string | undefined)[], owners: string[]): Promise<Record<string, Decoded[]>> {
    const userPermits: Record<string, Decoded[]> = {};
    for (const owner of owners) {
      const gtxs = await this.getGnosisTxs(owner);
      const etxs = await this.getEthTxs(owner);

      const methodId = "0x30f28b7a";
      const gnosisPermitLogs = gtxs.result.filter((tx: { input: string }) => tx.input.startsWith(methodId));
      const ethPermitLogs = etxs.result.filter((tx: { input: string }) => tx.input.startsWith(methodId));
      const permitLogs = [...gnosisPermitLogs, ...ethPermitLogs];

      for (const log of permitLogs) {
        // from ubq to hunter
        const to = log.to.toLowerCase();
        if (!userWallets.includes(to)) continue;
        const decoded = this.decodePermit(log.input);
        decoded.txHash = log.hash;
        if (!userPermits[to]) {
          userPermits[to] = [];
        }

        userPermits[to].push(decoded);
      }
    }

    return userPermits;
  }

  async processUsers(idToWalletMap: Map<number, string>, users: User[]): Promise<Record<string, Decoded[]>> {
    const userPermits: Record<string, Decoded[]> = {};
    for (const user of users) {
      const userWallet = idToWalletMap.get(user.wallet_id)?.toLowerCase();
      if (!userWallet) continue;

      const gtxs = await this.getGnosisTxs(userWallet);
      const etxs = await this.getEthTxs(userWallet);

      const methodId = "0x30f28b7a";
      const gnosisPermitLogs = gtxs.result.filter((tx: { input: string }) => tx.input.startsWith(methodId));
      const ethPermitLogs = etxs.result.filter((tx: { input: string }) => tx.input.startsWith(methodId));
      const permitLogs = [...gnosisPermitLogs, ...ethPermitLogs];

      for (const log of permitLogs) {
        // from hunter to permit2 using hunter tx history
        if (log.from.toLowerCase() !== userWallet) continue;
        const decoded = this.decodePermit(log.input);
        decoded.txHash = log.hash;

        if (!userPermits[userWallet]) {
          userPermits[userWallet] = [];
        }

        userPermits[userWallet].push(decoded);
      }
    }

    return userPermits;
  }

  async getBlockNumbers() {
    const eth = await this.ethProvider.getBlockNumber();
    const gnosis = await this.gnosisProvider.getBlockNumber();

    return { eth, gnosis };
  }

  async getEthTxs(address: string) {
    const toBlock = (await this.getBlockNumbers()).eth;
    const fromBlock = 13373290; // 2.5yrs ago
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=${fromBlock}&endblock=${toBlock}&page=1&offset=1000&sort=asc&apikey=${this.etherscanApiKey}`;
    const response = await fetch(url);
    return await response.json();
  }

  async getGnosisTxs(address: string) {
    const toBlock = (await this.getBlockNumbers()).gnosis;
    const fromBlock = 18349006; // 2.5yrs ago
    const url = `https://api.gnosisscan.io/api?module=account&action=txlist&address=${address}&startblock=${fromBlock}&endblock=${toBlock}&page=1&offset=1000&sort=asc&apikey=${this.gnosisApiKey}`;
    const response = await fetch(url);
    return await response.json();
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
//   const parser = new UserBlockTxParser();
//   await parser.run();
// }

// main()
//   .catch(console.error)
//   .finally(() => process.exit(0));
