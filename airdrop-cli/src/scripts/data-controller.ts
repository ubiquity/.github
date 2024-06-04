import { PaidIssueParser } from "./paid-issue-parser";
import { UserBlockTxParser } from "./user-tx-parser";
import { DuneDataParser } from "./dune-data-parser";
// import { PopulateDB } from "./populate-db";
import { Decoded, FinalData, IssueOut, PermitEntry, ScanResponse, User } from "../types";
import { writeFile } from "fs/promises";
import { Tokens, UBQ_OWNERS } from "../utils/constants";
import { ethers } from "ethers";
import { formatUnits } from "viem";
import { getSupabaseData } from "./utils";

// import DUNE_SIGS from "./data/dune-sigs.json";
// import ISSUE_SIGS from "./data/issue-sigs.json";
// import USER_SIGS from "./data/user-tx-sigs.json";

const tokens = {
  [Tokens.WXDAI]: 1, // permits in DB exist with WXDAI as token_id == 1
  [Tokens.DAI]: 2, // since no other tokens as of yet, we can assume DAI is 2
};

/**
 * Because the data is spread across multiple sources, this controller
 * will gather all the data and prepare it for the database.
 *
 * Our most fruitful method of gathering data is the `PaidIssueParser`.
 * While most fruitful, it lacks any on-chain evidence after the fact.
 *
 * The lesser of the two do include txHashes, so we'll match what we can.
 * As we have a unique nonce for each permit and all sources contain
 * nonces, we can match on that.
 *
 * Specifically, it will:
 * 1. Gather data from each parser
 * 2. Match on-chain data with off-chain data
 * 3. Prepare the data for the database
 * 4. Populate the database
 * 
singles length:  333 w/o onchain data + 21 invalidated nonces
doubles length:  264
triples length:  185
 */

export class DataController {
  issueParser: PaidIssueParser;
  userTxParser: UserBlockTxParser;
  duneParser: DuneDataParser;
  // dbPopulator: PopulateDB;

  issueSigMap: Record<string, IssueOut> = {};
  duneSigMap: Record<string, Decoded> = {};
  userTxSigMap: Record<string, Decoded> = {};

  usernameToWalletMap = new Map<string, string>();
  walletToIdMap = new Map<string, number>();
  idToWalletMap = new Map<number, string>();
  users: User[] | null = [];

  finalData: Record<string, FinalData[]> = {};
  finalDataViaSig: Record<string, FinalData> = {};

  singles: Record<string, FinalData> = {};
  doubles: Record<string, FinalData> = {};
  triples: Record<string, FinalData> = {};

  nonceMap: Map<string, FinalData[]> = new Map();
  withoutIssueNumberOrRepoName: Record<string, FinalData> = {};

  constructor() {
    this.issueParser = new PaidIssueParser();
    this.userTxParser = new UserBlockTxParser();
    this.duneParser = new DuneDataParser();
    // this.dbPopulator = new PopulateDB();
  }

  async run() {
    await this.gatherData();
    await this.matchAll();
    await this.findAndRemoveInvalidatedNonces();
    await this.matchAll();

    console.log("singles length: ", Object.keys(this.singles).length, "w/o onchain data + 21 invalidated nonces");
    console.log("doubles length: ", Object.keys(this.doubles).length);
    console.log("triples length: ", Object.keys(this.triples).length);
    await writeFile("src/scripts/data/dc-singles.json", JSON.stringify(this.singles, null, 2));
    await writeFile("src/scripts/data/dc-doubles.json", JSON.stringify(this.doubles, null, 2));
    await writeFile("src/scripts/data/dc-triples.json", JSON.stringify(this.triples, null, 2));
    await writeFile("src/scripts/data/dc-without-issue-or-repo.json", JSON.stringify(this.withoutIssueNumberOrRepoName, null, 2));

    return await this.leaderboard();
  }

  async findAndRemoveInvalidatedNonces() {
    const invalidatedNonces = [] as { hash: string; owner: string; nonce: string; wordPos: string; bitPos: string }[];
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
          invalidatedNonces.push({
            nonce: invalidated.nonce.toString(),
            wordPos: invalidated.wordPos.toString(),
            bitPos: invalidated.bitPos.toString(),
            owner: owner,
            hash: scan.hash,
          });
        }
      }
    }

    await writeFile("src/scripts/data/dc-invalidated-nonces.json", JSON.stringify(invalidatedNonces, null, 2));
  }

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

    this.finalDataViaSig[signature] = merged;
    this.singles[signature] = merged;
  }

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

        delete this.finalDataViaSig[sig];
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

  async leaderboard() {
    const leaderboard: Record<string, number> = {};
    const claimedLeaderboard: Record<string, number> = {};
    const deduped: Map<string, string> = new Map();
    const newFinal: Record<string, FinalData[]> = {};
    const dbEntries: Record<string, PermitEntry[]> = {};

    for (const [user, permits] of Object.entries(this.finalData)) {
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
      transaction: txHash,
    };
  }

  async gatherData() {
    const userInfo = await getSupabaseData();

    this.idToWalletMap = userInfo.idToWalletMap;
    this.users = userInfo.users;
    this.walletToIdMap = userInfo.walletToIdMap;

    const done = await Promise.all([this.issueParser.run(), this.userTxParser.run(), this.duneParser.run()]);

    if (done.length) {
      this.issueSigMap = this.issueParser.sigPaymentInfo;
      this.duneSigMap = this.duneParser.sigMap;
      this.userTxSigMap = this.userTxParser.userSigPermits;
    }

    return done;

    // this.issueSigMap = ISSUE_SIGS as unknown as Record<string, IssueOut>;
    // this.duneSigMap = DUNE_SIGS as unknown as Record<string, Decoded>;
    // this.userTxSigMap = USER_SIGS as unknown as Record<string, Decoded>;
  }
}

async function main() {
  const parser = new DataController();
  await parser.run();
}
main()
  .catch(console.error)
  .finally(() => process.exit(0));
