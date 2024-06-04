import { IssueOut, PaidIssueParser } from "./paid-issue-parser";
import { UserBlockTxParser } from "./user-tx-parser";
import { DuneDataParser } from "./dune-data-parser";
// import { PopulateDB } from "./populate-db";
import { Decoded, FinalData, PermitDetails, ScanResponse, User } from "../types";
import { writeFile } from "fs/promises";
import { Tokens, UBQ_OWNERS } from "../utils/constants";
import { ethers } from "ethers";
import { formatUnits } from "viem";
import { txFinder } from "./tx-finding";

import ISSUE_USER_WALLET_PERMITS from "./data/paid-out-wallet-permits.json";
import ISSUE_USER_SIG_PERMITS from "./data/paid-out-sig-permits.json";

import USER_TX_WALLET_PERMITS from "./data/user-tx-permits.json";
import USER_TX_SIG_PERMITS from "./data/user-sig-permits.json";

import DUNE_PERMITS from "./data/dune-permits.json";
import DUNE_SIG_PERMITS from "./data/dune-sig-map.json";

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
singles length:  415 w/o onchain data + 21 invalidated nonces
doubles length:  270
triples length:  239
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
    await this.rescanOnchainForSingles();
    await this.findAndRemoveInvalidatedNonces();
    await this.filterSets();
    await this.leaderboard();
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

  async filterSets() {
    console.log("singles length: ", Object.keys(this.singles).length);
    console.log("doubles length: ", Object.keys(this.doubles).length);
    console.log("triples length: ", Object.keys(this.triples).length);

    for (const [sig, permit] of Object.entries(this.singles)) {
      if (permit.blockTimestamp && permit.commentTimestamp) {
        delete this.singles[sig];
        this.doubles[sig] = permit;
      }

      if (!permit.repoName || !permit.issueNumber) {
        delete this.singles[sig];
        this.withoutIssueNumberOrRepoName[sig] = permit;
      }
    }

    for (const [sig, permit] of Object.entries(this.doubles)) {
      if (!(permit.blockTimestamp && permit.commentTimestamp)) {
        delete this.doubles[sig];
        this.singles[sig] = permit;
      }
    }

    console.log("singles length: ", Object.keys(this.singles).length);
    console.log("doubles length: ", Object.keys(this.doubles).length);
    console.log("triples length: ", Object.keys(this.triples).length);
  }

  isOnAndOffChainMatched(permits: [IssueOut, Decoded, Decoded], sigs: [string, string, string]) {
    /**
     * Only adding to doubles if we can match on-chain data with off-chain data
     * so only (issuePermit && dunePermit) || (issuePermit && userTxPermit)
     */
    const [issuePermit, dunePermit, userTxPermit] = permits;
    const [issueSig, utxSig, duneSig] = sigs;

    if (utxSig === issueSig || duneSig === issueSig) {
      return this.produceFinalData([issuePermit, dunePermit, userTxPermit]);
    }

    return null;
  }

  async rescanOnchainForSingles() {
    const users = Object.values(this.singles).map((permit) => permit.to.toLowerCase());
    const userSet = new Set(users);
    const userSingles: Record<string, FinalData[]> = {};

    console.log(`Rescanning ${userSet.size} users`);
    for (const user of userSet) {
      if (this.walletToIdMap.has(user)) {
        const _userSingles = Object.values(this.singles).filter((permit) => permit.to.toLowerCase() === user);

        if (!_userSingles || _userSingles.length === 0) continue;
        userSingles[user] = _userSingles;

        const gnoOnlyWithValue = _userSingles.filter((permit) => permit.token.toLowerCase() === Tokens.WXDAI.toLowerCase() && permit.amount > 0);
        const ethOnlyWithValue = _userSingles.filter((permit) => permit.token.toLowerCase() === Tokens.DAI.toLowerCase() && permit.amount > 0);

        if (gnoOnlyWithValue.length === 0 && ethOnlyWithValue.length === 0) continue;

        await txFinder(gnoOnlyWithValue, user, this.userTxParser);
        await txFinder(ethOnlyWithValue, user, this.userTxParser);
      }
    }
  }

  mergedFinalAndDecoded(single: FinalData, found: Decoded) {
    const signature = found.signature.toLowerCase();
    const userTxMapHasSig = this.userTxSigMap[signature];
    const duneMapHasSig = this.duneSigMap[signature];

    const merged: FinalData & Decoded = {
      // DC
      nonce: single.nonce ?? found.nonce,
      permitted: found.permitted,
      signature: found.signature ?? single.signature,
      to: single.to ?? found.to,
      txHash: found.txHash ?? single.txHash,
      blockTimestamp: found.blockTimestamp ?? single.blockTimestamp,
      issueNumber: single.issueNumber ?? found.issueNumber,
      permitOwner: single.owner ?? found.permitOwner,
      repoName: single.repoName ?? found.repoName,
      // FD
      amount: single.amount ?? parseFloat(formatUnits(BigInt(found.permitted.amount), 18)),
      owner: single.owner ?? found.permitOwner,
      token: single.token ?? found.permitted.token,
      commentTimestamp: single.commentTimestamp,
    };

    this.finalDataViaSig[signature] = merged;
    if (userTxMapHasSig && duneMapHasSig) {
      this.triples[signature] = merged;
      return;
    } else if (userTxMapHasSig || duneMapHasSig) {
      this.doubles[signature] = merged;
      return;
    }

    this.singles[signature] = merged;
  }

  async matchAll() {
    const allSigs = [...Object.keys(this.userTxSigMap), ...Object.keys(this.duneSigMap), ...Object.keys(this.issueSigMap)];
    allSigs.forEach((sig) => {
      const userTxPermit = this.userTxSigMap[sig as keyof typeof this.userTxSigMap] as unknown as Decoded;
      const dunePermit = this.duneSigMap[sig as keyof typeof this.duneSigMap] as unknown as Decoded;
      const issuePermit = this.issueSigMap[sig as keyof typeof this.issueSigMap] as unknown as IssueOut;

      const amount = dunePermit?.permitted.amount ?? issuePermit?.permit.permit.permitted.amount ?? userTxPermit?.permitted.amount ?? null;
      const formattedAmount = parseFloat(formatUnits(BigInt(amount), 18));

      if (!amount || formattedAmount === 0) {
        return;
      }

      const isTriple = issuePermit && dunePermit && userTxPermit;
      const isDouble = (issuePermit && dunePermit) || (issuePermit && userTxPermit);
      const finalData = this.produceFinalData([issuePermit, dunePermit, userTxPermit]);

      if (isTriple) {
        this.triples[sig] = finalData;
      } else if (isDouble) {
        this.doubles[sig] = finalData;
      } else {
        this.singles[sig] = finalData;
      }

      const to = finalData.to.toLowerCase();
      if (!this.finalData[to]) {
        this.finalData[to] = [];
      }

      this.finalData[to].push(finalData);
      this.finalDataViaSig[sig] = finalData;

      const nonceMap = this.nonceMap.get(finalData.nonce);

      if (nonceMap) {
        this.nonceMap.set(finalData.nonce, [...nonceMap, finalData]);
      } else {
        this.nonceMap.set(finalData.nonce, [finalData]);
      }
    });
  }

  produceFinalData(permits: [IssueOut, Decoded, Decoded]) {
    const [issuePermit, dunePermit, userTxPermit] = permits;

    const amount = dunePermit?.permitted.amount ?? issuePermit?.permit.permit.permitted.amount ?? userTxPermit?.permitted.amount ?? null;
    const blockTimestamp = userTxPermit?.blockTimestamp ?? dunePermit?.blockTimestamp ?? null;
    const commentTimestamp = issuePermit?.timestamp ?? null;
    const txHash = userTxPermit?.txHash ?? dunePermit?.txHash;
    const nonce = userTxPermit?.nonce ?? dunePermit?.nonce ?? issuePermit?.permit.permit.nonce ?? null;
    const token = userTxPermit?.permitted.token ?? dunePermit?.permitted.token ?? issuePermit?.permit.permit.permitted.token ?? null;
    const to = userTxPermit?.to ?? dunePermit?.to ?? issuePermit?.permit.transferDetails.to ?? null;

    return {
      repoName: issuePermit?.repoName ?? null,
      issueNumber: issuePermit?.issueNumber ?? null,
      amount: parseFloat(formatUnits(BigInt(amount), 18)),
      blockTimestamp,
      commentTimestamp,
      txHash,
      nonce,
      token,
      to,
      owner: userTxPermit?.permitOwner ?? dunePermit?.permitOwner ?? issuePermit?.permit.owner ?? null,
      signature: userTxPermit?.signature ?? dunePermit?.signature ?? issuePermit?.permit.signature ?? null,
    } as FinalData;
  }

  async getDecodedData(permit: PermitDetails, issueNumber?: number) {
    if (Array.isArray(permit)) {
      permit = permit[0];
    }

    return {
      nonce: permit.permit.nonce,
      signature: permit.signature,
      permitted: permit.permit.permitted,
      to: permit.transferDetails.to,
      txHash: permit.txHash,
      permitOwner: permit.owner,
      issueNumber: issueNumber,
      repoName: permit.repoName,
    };
  }

  async decodeInvalidate(data: ScanResponse) {
    const decoded = this.userTxParser.permitDecoder.decodeFunctionData("invalidateUnorderedNonces", data.input);

    const wordPos = ethers.BigNumber.from(decoded[0].toString());
    const bitPos = decoded[1];

    const nonce = wordPos.shl(8).or(bitPos);
    const nonceMap = this.nonceMap.get(nonce.toString());

    if (nonceMap) {
      nonceMap.forEach((permit) => {
        const sig = permit?.signature?.toLowerCase();
        if (!sig) return;

        delete this.finalDataViaSig[sig];
        delete this.singles[sig];
        delete this.doubles[sig];
        delete this.triples[sig];
        delete this.userTxSigMap[sig];
        delete this.duneSigMap[sig];
        delete this.issueSigMap[sig];

        const finalDIndex = this.finalData[permit.to.toLowerCase()].indexOf(permit);
        this.finalData[permit.to.toLowerCase()].splice(finalDIndex, 1);
      });
    }
    return { nonce, wordPos, bitPos };
  }

  async leaderboard() {
    const leaderboard: Record<string, number> = {};
    const claimedLeaderboard: Record<string, number> = {};
    const deduped: Map<string, string> = new Map();
    const newFinal: Record<string, FinalData[]> = {};

    for (const [user, permits] of Object.entries(this.finalData)) {
      for (const permit of permits) {
        const sig = permit.nonce;
        if (!sig) continue;
        if (deduped.has(sig)) continue;

        deduped.set(sig, user);

        if (!leaderboard[user]) leaderboard[user] = 0;
        if (!claimedLeaderboard[user]) claimedLeaderboard[user] = 0;
        if (!newFinal[user]) newFinal[user] = [];

        leaderboard[user] += permit.amount;
        if (permit.txHash) claimedLeaderboard[user] += permit.amount;

        newFinal[user].push(permit);
      }
    }

    await writeFile("src/scripts/data/dc-singles.json", JSON.stringify(this.singles, null, 2));
    await writeFile("src/scripts/data/dc-doubles.json", JSON.stringify(this.doubles, null, 2));
    await writeFile("src/scripts/data/dc-triples.json", JSON.stringify(this.triples, null, 2));
    await writeFile("src/scripts/data/dc-without-issue-or-repo.json", JSON.stringify(this.withoutIssueNumberOrRepoName, null, 2));
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

  async gatherData() {
    const userInfo = await this.issueParser.getSupabaseData();

    this.idToWalletMap = userInfo.idToWalletMap;
    this.users = userInfo.users;
    this.walletToIdMap = userInfo.walletToIdMap;

    await this.issueParser.run();
    await this.userTxParser.run();
    await this.duneParser.run();

    this.issueSigMap = this.issueParser.sigPaymentInfo;
    this.duneSigMap = this.duneParser.duneSigMap;
    this.userTxSigMap = this.userTxParser.userTxSigMap;

    // this.issueSigMap = ISSUE_USER_SIG_PERMITS as unknown as Record<string, IssueOut>;
    // this.duneSigMap = DUNE_SIG_PERMITS as unknown as Record<string, Decoded>;
    // this.userTxSigMap = USER_TX_SIG_PERMITS as unknown as Record<string, Decoded>;
  }
}

async function main() {
  const parser = new DataController();
  await parser.run();
}
main()
  .catch(console.error)
  .finally(() => process.exit(0));
