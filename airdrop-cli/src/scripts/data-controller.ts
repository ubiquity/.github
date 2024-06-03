import { IssueOut, PaidIssueParser } from "./paid-issue-parser";
import { UserBlockTxParser } from "./user-tx-parser";
import { DuneDataParser } from "./dune-data-parser";
// import { PopulateDB } from "./populate-db";
import { Decoded, FinalData, PermitDetails, ScanResponse, User } from "../types";
import { writeFile } from "fs/promises";
import { PERMIT2_ADDRESS, Tokens, UBQ_OWNERS } from "../utils/constants";
import { BigNumber, BigNumberish, ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { formatUnits } from "viem";

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

  constructor() {
    this.issueParser = new PaidIssueParser();
    this.userTxParser = new UserBlockTxParser();
    this.duneParser = new DuneDataParser();
    // this.dbPopulator = new PopulateDB();
  }

  async run() {
    await this.gatherData();
    await this.matchThree();
    await this.rescanOnchainForSingles();
    await this.findAndRemoveInvalidatedNonces();
    await this.filterSets();
    await this.leaderboard();
  }

  async findAndRemoveInvalidatedNonces() {
    const invalidatedNonces = [] as { owner: string; nonce: string; wordPos: string; bitPos: string }[];
    for await (const owner of UBQ_OWNERS) {
      const scans: ScanResponse[][] = [];

      scans.push(await this.userTxParser.getGnosisTxs(owner, undefined, undefined, false));
      scans.push(await this.userTxParser.getEthTxs(owner, undefined, undefined, false));

      const filteredScans = scans.flat().filter((scan) => scan.methodId === "0x3ff9dcb1");
      if (filteredScans.length === 0) continue;

      console.log(`Found ${filteredScans.length} invalidated nonces for ${owner}`);
      await writeFile("src/scripts/data/dc-invalidated-nonces.json", JSON.stringify(filteredScans, null, 2));

      for (const scan of filteredScans) {
        const invalidated = await this.decodeInvalidate(scan);
        if (invalidated) {
          invalidatedNonces.push({
            nonce: invalidated.nonce.toString(),
            wordPos: invalidated.wordPos.toString(),
            bitPos: invalidated.bitPos.toString(),
            owner: owner,
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

        await this.txFinder(gnoOnlyWithValue, user);
        await this.txFinder(ethOnlyWithValue, user);
      }
    }
  }

  async txFinder(userSingles: FinalData[], user: string) {
    if (!userSingles || userSingles.length === 0) return;
    const networkID = userSingles[0].token.toLowerCase() === Tokens.WXDAI ? "100" : "1";
    const scans: ScanResponse[][] = [];

    if (networkID === "100") {
      scans.push(await this.userTxParser.getGnosisTxs(user, undefined, undefined, false));
    } else if (networkID === "1") {
      scans.push(await this.userTxParser.getEthTxs(user, undefined, undefined, false));
    }

    const filteredScans = scans.flat().filter((scan) => scan.methodId === "0x30f28b7a");
    if (filteredScans.length === 0) return null;

    const decodedPermits = filteredScans.map((scan) => this.userTxParser.decodePermit(scan));
    if (decodedPermits.length === 0) return null;

    return await this.findTx(userSingles, decodedPermits);
  }

  async findTx(userSingles: FinalData[], decodedPermits: Decoded[]) {
    for (const single of userSingles) {
      if (single.commentTimestamp && !single.blockTimestamp) {
        // we know when the permit was generated
        const isInvalid = await this.isNonceValid(single.nonce, single.owner, single.token);
        if (isInvalid) {
          /**
           * Now this could mean either that the nonce was
           * invalidated by the owner or the permit has been claimed
           */
          single.claimed = true;
          continue;
        }

        const found = await this.findNearestTx(decodedPermits, single);

        if (!found) {
          single.blockTimestamp = null;
          single.claimed = false;
          continue;
        }

        single.blockTimestamp = found.blockTimestamp;
        single.claimed = true;
        single.txHash = found.txHash;

        await this.matchThree([single, found]);
      } else if (!(single.issueNumber && single.repoName && single.commentTimestamp) && single.blockTimestamp && !single.commentTimestamp) {
        // we know when the permit was used
      }
    }
  }

  async findNearestTx(decodedPermits: Decoded[], permit: FinalData) {
    const decodedTimestamp = new Date(permit.commentTimestamp ?? "0").getTime();

    const matchingDecodedPermits = decodedPermits.filter((decoded) => {
      const pAmount = parseFloat(permit.amount.toString());
      const dAmount = parseFloat(formatUnits(BigInt(decoded.permitted.amount), 18));
      return pAmount === dAmount;
    });

    if (!matchingDecodedPermits.length) return null;

    return matchingDecodedPermits.reduce((acc, match) => {
      const matchDate = new Date(match.blockTimestamp ?? "0").getTime();
      const accDate = new Date(acc.blockTimestamp ?? "0").getTime();
      const decodedDate = new Date(decodedTimestamp).getTime();
      const isAmountMatch = parseFloat(permit.amount.toString()) === parseFloat(formatUnits(BigInt(match.permitted.amount), 18));

      if (!isAmountMatch) return acc;

      if (matchDate < decodedDate) {
        return match;
      }

      if (matchDate > accDate) {
        return match;
      }

      return acc;
    });
  }

  async matchThree(data?: [FinalData, Decoded]) {
    if (data) {
      const [single, found] = data;
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

      if (merged.blockTimestamp && merged.commentTimestamp) {
        merged.claimed = true;
      }

      if (userTxMapHasSig && duneMapHasSig) {
        this.triples[signature] = merged;
      } else if (userTxMapHasSig || duneMapHasSig) {
        this.doubles[signature] = merged;
      } else {
        this.singles[signature] = merged;
      }

      this.finalData[merged.to.toLowerCase()].push(merged);
      this.finalDataViaSig[signature] = merged;

      const nonceMap = this.nonceMap.get(merged.nonce);
      if (nonceMap) {
        this.nonceMap.set(merged.nonce, [...nonceMap, merged]);
      } else {
        this.nonceMap.set(merged.nonce, [merged]);
      }

      return;
    }

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

  async isNonceValid(nonce: string, owner: string, token: string) {
    const ethProvider = this.userTxParser.ethProvider;
    const gnosisProvider = this.userTxParser.gnosisProvider;
    const activeProvider = token === Tokens.WXDAI ? gnosisProvider : ethProvider;

    return await this.invalidateNonce(nonce, owner, activeProvider);
  }

  nonceBitmap(nonce: BigNumberish): { wordPos: BigNumberish; bitPos: number } {
    // wordPos is the first 248 bits of the nonce
    const wordPos = BigNumber.from(nonce).shr(8);
    // bitPos is the last 8 bits of the nonce
    const bitPos = BigNumber.from(nonce).and(255).toNumber();
    return { wordPos, bitPos };
  }

  async invalidateNonce(nonce: string, owner: string, provider: ethers.providers.WebSocketProvider): Promise<boolean> {
    const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, permit2Abi, provider);

    const { wordPos, bitPos } = this.nonceBitmap(BigNumber.from(nonce));
    const bitmap = await permit2Contract.nonceBitmap(owner, wordPos);

    const bit = BigNumber.from(1).shl(bitPos);
    const flipped = BigNumber.from(bitmap).xor(bit);

    return bit.and(flipped).eq(0);
  }

  async leaderboard() {
    const leaderboard: Record<string, number> = {};
    const claimedLeaderboard: Record<string, number> = {};
    const deduped: Map<string, string> = new Map();
    const newFinal: Record<string, FinalData[]> = {};

    for (const [user, permits] of Object.entries(this.finalData)) {
      for (const permit of permits) {
        const sig = permit.signature?.toLowerCase();
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

    this.finalData = newFinal;

    await writeFile("src/scripts/data/dc-final-data.json", JSON.stringify(this.finalData, null, 2));
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

    const userTxWalletPermits = USER_TX_WALLET_PERMITS;
    const duneWalletPermits = DUNE_PERMITS;
    const issueWalletPermits = ISSUE_USER_WALLET_PERMITS;

    this.issueSigMap = ISSUE_USER_SIG_PERMITS as unknown as Record<string, IssueOut>;
    this.duneSigMap = DUNE_SIG_PERMITS as unknown as Record<string, Decoded>;
    this.userTxSigMap = USER_TX_SIG_PERMITS as unknown as Record<string, Decoded>;

    return {
      userTxHistoryPermits: { userTxWalletPermits },
      duneData: { duneWalletPermits },
      issueData: { issueWalletPermits },
    };
  }
}

async function main() {
  const parser = new DataController();
  await parser.run();
}
main()
  .catch(console.error)
  .finally(() => process.exit(0));
