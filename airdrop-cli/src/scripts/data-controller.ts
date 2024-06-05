import { UserBlockTxParser } from "./user-tx-parser";
import { Decoded, FinalData, IssueOut, PermitEntry, ScanResponse, User } from "../types";
import { writeFile } from "fs/promises";
import { SUPABASE_ANON_KEY, SUPABASE_URL, TOKENS, UBQ_OWNERS } from "../utils/constants";
import { ethers } from "ethers";
import { formatUnits } from "viem";
import { getSupabaseData } from "./utils";
import { createClient } from "@supabase/supabase-js";

const tokens = {
  [TOKENS.WXDAI]: 1, // permits in DB exist with WXDAI as token_id == 1
  [TOKENS.DAI]: 2, // since no other tokens as of yet, we can assume DAI is 2
};

/**
 * Because the data is spread across multiple sources, this controller
 * will gather all the data and prepare it for the database.
 *
 * Specifically, it will:
 * 1. Gather data from each parser
 * 2. Match on-chain data with off-chain data
 * 3. Prepare the data for the database
 * 4. Populate the database

  Found 776 total entries
  Entries with tx: 439
  Entries without tx: 338
  Found 21 invalidated nonces
  Found 15 repos with duplicate nonces

 * Found 15 repos with duplicate nonces:
 * Repo: production has 14 duplicate nonces
 * Repo: ubiquibar has 2 duplicate nonces
 * Repo: ubiquibot has 14 duplicate nonces
 * Repo: research has 2 duplicate nonces
 * Repo: comment-incentives has 6 duplicate nonces
 * Repo: ts-template has 2 duplicate nonces
 * Repo: devpool-directory-bounties has 19 duplicate nonces
 * Repo: recruiting has 2 duplicate nonces
 * Repo: ubiquibot-kernel has 2 duplicate nonces
 * Repo: cloudflare-deploy-action has 8 duplicate nonces
 * Repo: business-development has 8 duplicate nonces
 * Repo: permit-generation has 2 duplicate nonces
 * Repo: ubiquity-dollar has 9 duplicate nonces
 * Repo: sponsorships has 5 duplicate nonces
 * Repo: sandbox has 2 duplicate nonces
 */

export class DataController {
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  userTxParser = new UserBlockTxParser();

  issueSigMap: Record<string, IssueOut> = {};
  duneSigMap: Record<string, Decoded> = {};
  userTxSigMap: Record<string, Decoded> = {};

  walletToIdMap = new Map<string, number>();
  users: User[] | null = [];

  singles: Record<string, FinalData> = {};
  doubles: Record<string, FinalData> = {};
  triples: Record<string, FinalData> = {};

  finalData: Record<string, FinalData[]> = {};
  nonceMap: Map<string, FinalData[]> = new Map();
  invalidatedNonces = [] as { hash: string; owner: string; nonce: string; wordPos: string; bitPos: string }[];

  async run() {
    await this.gatherData();
    await this.matchAll();
    await this.findAndRemoveInvalidatedNonces();

    await this.leaderboard();
  }

  /**
   * Finds transactions matching the `invalidateUnorderedNonces` method
   * from the four known UBQ owners and removes those nonces from the
   * final data.
   */
  async findAndRemoveInvalidatedNonces() {
    for await (const owner of UBQ_OWNERS) {
      const scans: ScanResponse[][] = [];

      scans.push(
        await this.userTxParser.getChainTx(owner, undefined, undefined, false, 1),
        await this.userTxParser.getChainTx(owner, undefined, undefined, false, 100)
      );

      const filteredScans = scans.flat().filter((scan) => scan.methodId === "0x3ff9dcb1");
      if (filteredScans.length === 0) continue;

      for (const scan of filteredScans) {
        const invalidated = await this.decodeInvalidate(scan);
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

      this.finalData[finalData.reward.transferDetails.to] = [...(this.finalData[finalData.reward.transferDetails.to] ?? []), finalData];
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
  async decodeInvalidate(data: ScanResponse) {
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
        dbEntries[repoName].push(entry);
      }
    }
    await this.populateDB(dbEntries);

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

  // Convert our FinalData objects into a DB friendly format.
  createPermitEntry(finalData: FinalData): PermitEntry {
    const { reward, txHash } = finalData;

    const tokenId = tokens[reward.permit.permitted.token.toLowerCase() as keyof typeof tokens];
    const to = reward.transferDetails.to.toLowerCase();
    const deadline = reward.permit.deadline;
    const nonce = reward.permit.nonce;
    const amount = reward.permit.permitted.amount;
    const signature = reward.signature;

    const beneficiaryId = this.walletToIdMap.get(to.toLowerCase()) ?? this.walletToIdMap.get(to);
    if (!beneficiaryId) {
      console.error(`Could not find beneficiaryId for ${to}`);
      throw new Error(`Could not find beneficiaryId for ${to}`);
    }

    return {
      amount: amount.toString(),
      nonce,
      deadline,
      signature,
      token_id: tokenId.toString(),
      partner_id: "0", // assume UBQ is 0 since none exist with an id?
      beneficiary_id: beneficiaryId,
      transaction: txHash ?? undefined,
    };
  }

  /**
   * Populates the database with the data we have gathered.
   * Ensures only full bodied entries are added, so 439 entries in total.
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

    await writeFile("src/scripts/data/dc-duplicate-nonces.json", JSON.stringify(duplicateNonces, null, 2));
    await writeFile("src/scripts/data/dc-without-tx.json", JSON.stringify(thoseWithoutTx, null, 2));
    await writeFile("src/scripts/data/dc-with-tx.json", JSON.stringify(thoseWithTx, null, 2));

    /**
     * See the function comment for why this is commented out.
     *
     * for (let i = 0; i < thoseWithTx.length; i += 300) {
     *   await this.pushToDB(thoseWithTx.slice(i, i + 300));
     * }
     */
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

  /**
   * Tough to test this function since it's a direct call to the database
   * and the RLS setup means I cannot push to my DB without rebuilding the
   * prod DB due to constraints re: locations etc. And even that is a bit of a
   * pain since I have to reseed the DB with the correct data for all the other
   * tables that are related to this one. Plus, location is deprecated and will be
   * removed in the future.
   *
   * I don't think I'm even able to pull all the info I'd need to properly
   * test this function (tried seeding users and wallets to no avail),
   * and this is another reason why there are a lot of file writes in this script.
   */
  async pushToDB(batch: PermitEntry[]) {
    const { error } = await this.sb.from("permits").insert(batch);
    if (error) {
      console.error("Error inserting batch", error);
      throw error;
    }
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

main().catch(console.error);
