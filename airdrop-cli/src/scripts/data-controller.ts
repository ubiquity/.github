import { UserBlockTxParser } from "./user-tx-parser";
import { Decoded, FinalData, IssueOut, PermitDetails, PermitEntry, ScanResponse, User } from "../types";
import { writeFile } from "fs/promises";
import { SUPABASE_KEY, SUPABASE_URL, TOKENS, UBQ_OWNERS, PERMIT2_ADDRESS } from "../utils/constants";
import { ethers } from "ethers";
import { formatUnits } from "viem";
import { getSupabaseData, loader } from "./utils";
import { createClient } from "@supabase/supabase-js";
import { permit2Abi } from "../abis/permit2Abi";
import { BigNumber, BigNumberish } from "ethers";

const tokens = {
  [TOKENS.WXDAI]: 1, // permits in DB exist with WXDAI as token_id == 1
  [TOKENS.DAI]: 2, // since no other tokens as of yet, we can assume DAI is 2
};

export class DataController {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  userTxParser = new UserBlockTxParser();

  issueSigMap: Record<string, IssueOut> = {};
  duneSigMap: Record<string, Decoded> = {};
  userTxSigMap: Record<string, Decoded> = {};

  walletToIdMap = new Map<string, number>();
  users: User[] | null = [];
  userDict: Record<string, number> = {};
  nonUserPermits = [] as PermitEntry[];
  failedToPush: PermitEntry[] = [];

  singles: Record<string, FinalData> = {};
  doubles: Record<string, FinalData> = {};
  triples: Record<string, FinalData> = {};

  finalData: Record<string, FinalData[]> = {};
  nonceMap: Map<string, FinalData[]> = new Map();
  invalidatedNonces = [] as { hash: string; owner: string; nonce: string; wordPos: string; bitPos: string }[];

  async run() {
    const loader_ = loader();
    await this.gatherData();
    console.log("Gathered data");
    await this.matchAll();
    console.log("Matched all");
    await this.findAndRemoveInvalidatedNonces();
    console.log("Found and removed invalidated nonces");
    await this.leaderboard();
    console.log("Calculated leaderboard");
    await this.findUnspentPermits();
    console.log("Found unspent permits");

    clearInterval(loader_);
  }

  async findUnspentPermits() {
    const unspent: Record<string, FinalData[]> = {};

    for (const user of Object.keys(this.finalData)) {
      const userFinalData = this.finalData[user];

      const unspentPermits = userFinalData.filter((permit) => !permit.txHash);
      const unclaimedPermits = unspentPermits.filter(async (permit) => {
        return await this.invalidateNonce(permit.reward.permit.nonce, permit.reward.owner, this.userTxParser.gnosisProvider);
      });

      unclaimedPermits.forEach((permit) => {
        permit.claimUrl = this.rebuildPermitString(permit.reward) ?? "";
        return permit;
      });

      unspent[user] = unclaimedPermits;
    }

    await writeFile("src/scripts/data/dc-unspent-permits.json", JSON.stringify(unspent, null, 2));
  }

  nonceBitmap(nonce: BigNumberish): { wordPos: BigNumberish; bitPos: number } {
    // wordPos is the first 248 bits of the nonce
    const wordPos = BigNumber.from(nonce).shr(8);
    // bitPos is the last 8 bits of the nonce
    const bitPos = BigNumber.from(nonce).and(255).toNumber();
    return { wordPos, bitPos };
  }

  async invalidateNonce(nonce: string, owner: string, provider: ethers.providers.WebSocketProvider): Promise<boolean> {
    if (!nonce) throw new Error("No nonce provided");
    if (!owner) throw new Error("No owner provided");
    if (!provider) throw new Error("No provider provided");

    const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, permit2Abi, provider);
    const { wordPos, bitPos } = this.nonceBitmap(BigNumber.from(nonce));

    if (!wordPos || !bitPos) throw new Error("Could not calculate wordPos or bitPos");
    const bitmap = await permit2Contract.nonceBitmap(owner, wordPos);

    const bit = BigNumber.from(1).shl(bitPos);
    const flipped = BigNumber.from(bitmap).xor(bit);

    return bit.and(flipped).eq(0);
  }

  /**
   * Finds transactions matching the `invalidateUnorderedNonces` method
   * from the four known UBQ owners and removes those nonces from the
   * final data.
   *
   * The new websocket providers resolve the "this should not happen" error
   * although this function from time to time may either take a long time
   * or hang indefinitely. Cancelling the script and restarting it seems to
   * resolve the issue.
   */
  async findAndRemoveInvalidatedNonces() {
    for (const owner of UBQ_OWNERS) {
      const scans: ScanResponse[][] = [];

      scans.push(
        await this.userTxParser.getChainTx(owner, undefined, undefined, false, 1),
        await this.userTxParser.getChainTx(owner, undefined, undefined, false, 100)
      );

      const filteredScans = scans.flat().filter((scan) => scan.methodId === "0x3ff9dcb1");
      if (filteredScans.length === 0) continue;

      for (const scan of filteredScans) {
        const invalidated = this.decodeInvalidate(scan);
        if (invalidated) {
          this.invalidatedNonces.push({
            nonce: invalidated.nonce.toString(),
            wordPos: invalidated.wordPos.toString(),
            bitPos: invalidated.bitPos.toString(),
            owner: owner,
            hash: scan.hash,
          });
        }
      }
    }

    await writeFile("src/scripts/data/dc-singles.json", JSON.stringify(this.singles, null, 2));
    await writeFile("src/scripts/data/dc-doubles.json", JSON.stringify(this.doubles, null, 2));
    await writeFile("src/scripts/data/dc-triples.json", JSON.stringify(this.triples, null, 2));
    await writeFile("src/scripts/data/dc-invalidated-nonces.json", JSON.stringify(this.invalidatedNonces, null, 2));
  }

  /**
   * Creates our matching sets of data based on the signature.
   * The signature is used as opposed to the nonce because even tho a
   * nonce should never be used twice, on more than a few occasions it has
   * been for reasons like:
   * - generated permit for the wrong chain
   * - testing scenarios (multiple in /production repo, which is mostly for testing)
   * - likely other reasons
   */
  mergedFinalAndDecoded(single: FinalData, found: Decoded) {
    const signature = found?.reward.signature.toLowerCase() ?? single?.reward.signature.toLowerCase();
    const userTxMapHasSig = this.userTxSigMap[signature];
    const duneMapHasSig = this.duneSigMap[signature];

    const merged = {
      ...single,
      ...found,
    };

    delete this.singles[signature];
    delete this.doubles[signature];
    delete this.triples[signature];

    if (userTxMapHasSig && duneMapHasSig) {
      this.triples[signature] = merged;
      return;
    } else if (userTxMapHasSig || duneMapHasSig) {
      this.doubles[signature] = merged;
      return;
    }

    this.singles[signature] = merged;
  }

  /**
   * An unbiased matching on all the data we have gathered from
   * the three parsers. We match based on the following criteria:
   * - the permit amount is not 0
   * - the final data is not null
   * - the user exists in the walletToIdMap
   */
  async matchAll() {
    const allSigs = [...Object.keys(this.userTxSigMap), ...Object.keys(this.duneSigMap), ...Object.keys(this.issueSigMap)];
    allSigs.forEach((sig) => {
      const userTxPermit = this.userTxSigMap[sig as keyof typeof this.userTxSigMap] as unknown as Decoded;
      const dunePermit = this.duneSigMap[sig as keyof typeof this.duneSigMap] as unknown as Decoded;
      const issuePermit = this.issueSigMap[sig as keyof typeof this.issueSigMap] as unknown as IssueOut;
      const whichOnchain = userTxPermit ?? dunePermit;

      const amount =
        issuePermit?.reward?.permit?.permitted?.amount ?? dunePermit?.reward?.permit?.permitted?.amount ?? userTxPermit?.reward?.permit?.permitted?.amount;
      const formattedAmount = parseFloat(formatUnits(BigInt(amount), 18));

      if (!amount || formattedAmount === 0) return;

      const finalData = this.produceFinalData([issuePermit, dunePermit, userTxPermit]);

      if (!finalData) return;

      this.mergedFinalAndDecoded(finalData, whichOnchain);

      const nonce = finalData.reward.permit.nonce;
      const nonceMap = this.nonceMap.get(nonce);

      if (nonceMap) {
        this.nonceMap.set(nonce, [...nonceMap, finalData]);
      } else {
        this.nonceMap.set(nonce, [finalData]);
      }

      const to = finalData.reward.transferDetails.to;

      this.finalData[to.toLowerCase()] = [...(this.finalData[to.toLowerCase()] ?? []), finalData];
    });
  }

  /**
   * Returns a full bodied object which attempts to track permits
   * to their respective issueNumber and repo.
   *
   * We only want users from the walletIdMap as this is up-to-date
   * and there are a fair few user addresses that do not exist in Supabase
   * but they have been paid out via an issue permit.
   */
  produceFinalData(permits: [IssueOut, Decoded, Decoded]) {
    const [issuePermit, dunePermit, userTxPermit] = permits;
    const reward = issuePermit?.reward ? issuePermit.reward : dunePermit?.reward ?? userTxPermit?.reward;
    const to = reward.transferDetails.to;

    if (this.walletToIdMap.has(to.toLowerCase()) || this.walletToIdMap.has(to)) {
      const blockTimestamp = dunePermit?.blockTimestamp ?? userTxPermit?.blockTimestamp;
      const commentTimestamp = issuePermit?.timestamp;
      const issueAssignee = issuePermit?.issueAssignee;
      const issueCreator = issuePermit?.issueCreator;
      const issueNumber = issuePermit?.issueNumber;
      const repoName = issuePermit?.repoName;
      const claimUrl = issuePermit?.claimUrl;
      const txHash = userTxPermit?.txHash ?? dunePermit?.txHash;

      const finalData: FinalData = {
        blockTimestamp,
        claimUrl,
        issueAssignee,
        issueCreator,
        issueNumber,
        repoName,
        reward,
        timestamp: commentTimestamp,
        txHash: txHash ?? null,
      };

      return finalData;
    }
    return null;
  }

  /**
   * Breaks down the input data from the `invalidateUnorderedNonces`
   * method and removes all the nonces that were invalidated.
   */
  decodeInvalidate(data: ScanResponse) {
    const decoded = this.userTxParser.permitDecoder.decodeFunctionData("invalidateUnorderedNonces", data.input);

    const wordPos = ethers.BigNumber.from(decoded[0].toString());
    const bitPos = decoded[1];

    const nonce = wordPos.shl(8).or(bitPos);
    const nonceMap = this.nonceMap.get(nonce.toString());

    if (nonceMap) {
      nonceMap.forEach((permit) => {
        const sig = permit.reward.signature.toLowerCase();
        if (!sig) return;

        delete this.singles[sig];
        delete this.doubles[sig];
        delete this.triples[sig];
        delete this.userTxSigMap[sig];
        delete this.duneSigMap[sig];
        delete this.issueSigMap[sig];
      });
    }
    return { nonce, wordPos, bitPos };
  }

  /**
   * Calculates the leaderboard and writes the data into two files:
   * - dc-leaderboard.json
   * - dc-claimed-leaderboard.json
   *
   * The first file contains user tallies using all the data
   * The second file contains user tallies using only data
   * which have a transaction hash (so more than 50% of the data (439 / 776))
   *
   * Except in the case of Pavlovcik, and one other user,
   * the difference between a wallet's claimed and unclaimed
   * is typically < $1000 in the top 15, and a far tighter spread
   * for those below.
   */
  async leaderboard() {
    const leaderboard: Record<string, number> = {};
    const claimedLeaderboard: Record<string, number> = {};
    const deduped: Map<string, string> = new Map();
    const newFinal: Record<string, FinalData[]> = {};
    const dbEntries: Record<string, PermitEntry[]> = {};

    for (const [_user, permits] of Object.entries(this.finalData)) {
      const user = _user.toLowerCase();
      for (const permit of permits) {
        const sig = permit.reward.signature.toLowerCase();
        if (!sig) continue;
        if (deduped.has(sig)) continue;

        deduped.set(sig, user);
        const repoName = permit.repoName;
        const amount = permit.reward.permit.permitted.amount;
        const formattedAmount = parseFloat(formatUnits(BigInt(amount), 18));

        this._leaderboard(leaderboard, claimedLeaderboard, newFinal, dbEntries, user, repoName);

        leaderboard[user] += formattedAmount;

        if (permit.txHash) {
          claimedLeaderboard[user] += formattedAmount;
        }

        const entry = this.createPermitEntry(permit);
        newFinal[user].push(permit);
        if (entry) {
          dbEntries[repoName].push(entry);
        }
      }
    }

    await writeFile("src/scripts/data/dc-non-user-entries.json", JSON.stringify(this.nonUserPermits, null, 2));
    await writeFile("src/scripts/data/dc-db-entries.json", JSON.stringify(dbEntries, null, 2));
    await writeFile("src/scripts/data/dc-final-data.json", JSON.stringify(newFinal, null, 2));
    await writeFile(
      "src/scripts/data/dc-leaderboard.json",
      JSON.stringify(
        Object.entries(leaderboard)
          .sort((a, b) => b[1] - a[1])
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
        null,
        2
      )
    );
    await writeFile(
      "src/scripts/data/dc-claimed-leaderboard.json",
      JSON.stringify(
        Object.entries(claimedLeaderboard)
          .sort((a, b) => b[1] - a[1])
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
        null,
        2
      )
    );

    await this.populateDB(dbEntries);
  }

  // sonar workaround, it just instantiates the objects
  _leaderboard(
    leaderboard: Record<string, number>,
    claimedLeaderboard: Record<string, number>,
    newFinal: Record<string, FinalData[]>,
    dbEntries: Record<string, PermitEntry[]>,
    user: string,
    repoName: string
  ) {
    if (!leaderboard[user]) {
      leaderboard[user] = 0;
    }
    if (!newFinal[user]) {
      newFinal[user] = [];
    }
    if (!claimedLeaderboard[user]) {
      claimedLeaderboard[user] = 0;
    }
    if (!dbEntries[repoName]) {
      dbEntries[repoName] = [];
    }
  }
  /**
    * Converts legacy permits into the accepted format 
    * to make for easy claiming.
    */
  rebuildPermitString(reward: PermitDetails) {

    const { owner, permit, signature, transferDetails } = reward
    const { permitted } = permit;

    const token = permit.permitted.token.toLowerCase();

    const obj = {
      permit: {
        permitted: {
          amount: permitted.amount,
          token: permitted.token
        },
        deadline: permit.deadline,
        nonce: permit.nonce
      },
      transferDetails: {
        to: transferDetails.to,
        requestedAmount: transferDetails.requestedAmount
      },
      networkId: token === TOKENS.DAI ? 1 : 100,
      owner: owner,
      signature: signature,
      // this is dirty but it works
      type: token === TOKENS.DAI ? "erc20-permit" :
        token === TOKENS.WXDAI ? "erc20-permit" : "erc721-permit"
    }

    const base64 = Buffer.from(JSON.stringify([obj])).toString("base64");
    return `https://pay.ubq.fi/?claim=${base64}`;
  }

  // Convert our FinalData objects into a DB friendly format.
  createPermitEntry(finalData: FinalData): PermitEntry | null {
    const { reward, txHash } = finalData;

    const tokenId = tokens[reward.permit.permitted.token.toLowerCase() as keyof typeof tokens];
    const to = reward.transferDetails.to.toLowerCase();
    let deadline = reward.permit.deadline;
    const nonce = reward.permit.nonce;
    const amount = reward.permit.permitted.amount;
    const signature = reward.signature;

    if (typeof deadline === "object") {
      deadline = ethers.BigNumber.from(deadline).toString();
    }

    const walletId = this.walletToIdMap.get(to.toLowerCase()) ?? this.walletToIdMap.get(to);
    if (!walletId) {
      console.log("Wallet ID not found for", to);
      return null;
    }
    const user = this.userDict[walletId];

    if (!user) {
      this.nonUserPermits.push({
        amount: BigNumber.from(amount).toString(),
        nonce,
        deadline,
        signature,
        token_id: tokenId,
        beneficiary_id: walletId ?? 0,
        transaction: txHash ?? undefined,
      });

      return null;
    }

    return {
      amount: BigNumber.from(amount).toString(),
      nonce,
      deadline,
      signature,
      token_id: tokenId,
      beneficiary_id: user,
      transaction: txHash ?? undefined,
    };
  }

  /**
   * Populates the database with the data we have gathered.
   * Ensures only full bodied entries are added
   *
   * Does not attribute permits to the issue number or repo they belong to,
   * although this data is readily available in this.finalData.
   *
   * Removes duplicates and writes them to a file for further inspection.
   * Writes all entries without a transaction hash to a file for further inspection.
   */
  async populateDB(dbEntries: Record<string, PermitEntry[]>) {
    const duplicateNonces: Record<string, PermitEntry[]> = {};
    const repos = Object.keys(dbEntries);
    const nonceMap = new Map<string, PermitEntry>();
    const uniqueNonces = new Set<string>();

    for (const repo of repos) {
      const entries = dbEntries[repo];
      const nonces = entries.map((entry) => entry.nonce);
      const duplicates = nonces.filter((nonce) => nonces.filter((n) => n === nonce).length > 1);
      const isDupe = duplicates.some((nonce) => uniqueNonces.has(nonce));
      nonces.forEach((nonce) => uniqueNonces.add(nonce));

      if (duplicates.length > 0 && !isDupe) {
        duplicates.forEach((nonce) => {
          const entries = dbEntries[repo].filter((entry) => entry.nonce === nonce);
          duplicateNonces[repo] = entries;
        });
      }

      await this.processDupes(repo, entries, duplicates, duplicateNonces, nonceMap);
    }

    const { error, data } = await this.sb.from("permits").select("*");
    if (error) {
      console.error("Error selecting from permits", error);
      throw error;
    }

    const entries = Array.from(nonceMap.values());
    const invalidatedRemoved = entries.filter((entry) => !this.invalidatedNonces.find((invalidated) => invalidated.nonce === entry.nonce));
    const dbStoredRemoved = invalidatedRemoved.filter(({ nonce }) => !data.find((entry) => entry.nonce === nonce));
    const thoseWithTx = dbStoredRemoved.filter((entry) => entry.transaction);
    const thoseWithoutTx = dbStoredRemoved.filter((entry) => !entry.transaction);
    const highestId = data.reduce((acc, entry) => (entry.id > acc ? entry.id : acc), 0);
    await writeFile("src/scripts/data/dc-duplicate-nonces.json", JSON.stringify(duplicateNonces, null, 2));
    await writeFile("src/scripts/data/dc-without-tx.json", JSON.stringify(thoseWithoutTx, null, 2));
    await writeFile("src/scripts/data/dc-with-tx.json", JSON.stringify(thoseWithTx, null, 2));

    for (let i = 0; i < thoseWithTx.length; i++) {
      if (i % 15 === 0) console.log("Pushed", i, "of", thoseWithTx.length);
      await this.pushToDB(thoseWithTx[i], i, highestId);
      if (i === thoseWithTx.length - 1) console.log("Pushed", i, "of", thoseWithTx.length);
    }

    await writeFile("src/scripts/data/dc-failed-to-push.json", JSON.stringify(this.failedToPush, null, 2));
  }

  async processDupes(
    repo: string,
    entries: PermitEntry[],
    duplicates: string[],
    duplicateNonces: Record<string, PermitEntry[]>,
    nonceMap: Map<string, PermitEntry>
  ) {
    for (const entry of entries) {
      const hasDupes = duplicates.includes(entry.nonce);

      if (hasDupes) {
        const dupes = duplicateNonces[repo];
        // take whichever has the highest amount
        // and a transaction hash
        let found: PermitEntry | null = null;

        for (const dupe of dupes) {
          if (dupe.amount < entry.amount && entry.transaction) {
            found = entry;
          }
        }

        if (found) {
          nonceMap.set(entry.nonce, found);
        }
      } else {
        nonceMap.set(entry.nonce, entry);
      }
    }
  }

  async pushToDB(batch: PermitEntry, i: number, base: number) {
    const { error } = await this.sb.from("permits").insert({
      ...batch,
      id: base + i + 1,
    });
    if (error) {
      this.failedToPush.push(batch);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /**
   * If this script does it's job correctly vis-a-vis populating
   * the database, then this script should only need to be run
   * once and it'll be defunct after that, following completion of
   * https://github.com/ubiquity/audit.ubq.fi/issues/12.
   */
  async gatherData() {
    const userInfo = await getSupabaseData();

    this.users = userInfo.users;
    userInfo.users.forEach((user) => {
      this.userDict[user.wallet_id] = user.id;
    });

    this.walletToIdMap = userInfo.walletToIdMap;
    this.issueSigMap = ISSUE_SIGS as unknown as Record<string, IssueOut>;
    this.duneSigMap = DUNE_SIGS as unknown as Record<string, Decoded>;
    this.userTxSigMap = USER_SIGS as unknown as Record<string, Decoded>;
  }
}

import DUNE_SIGS from "./data/dune-sigs.json";
import ISSUE_SIGS from "./data/issue-sigs.json";
import USER_SIGS from "./data/user-tx-sigs.json";

async function main() {
  const parser = new DataController();
  await parser.run();
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
