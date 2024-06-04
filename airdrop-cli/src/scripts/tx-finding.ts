import { Decoded, FinalData, ScanResponse } from "../types";
import { Tokens } from "../utils/constants";
import { formatUnits } from "viem";
import { UserBlockTxParser } from "./user-tx-parser";

export async function txFinder(userSingles: FinalData[], user: string, userTxParser: UserBlockTxParser) {
  if (!userSingles || userSingles.length === 0) return;
  const networkID = userSingles[0].token.toLowerCase() === Tokens.WXDAI ? "100" : "1";
  const scans: ScanResponse[][] = [];

  if (networkID === "100") {
    scans.push(await userTxParser.getChainTx(user, undefined, undefined, false, 100));
  } else if (networkID === "1") {
    scans.push(await userTxParser.getChainTx(user, undefined, undefined, false, 1));
  }

  const filteredScans = scans.flat().filter((scan) => scan.methodId === "0x30f28b7a");
  if (filteredScans.length === 0) return;

  const decodedPermits = filteredScans.map((scan) => userTxParser.decodePermit(scan));
  if (decodedPermits.length === 0) return;

  return await findTx(userSingles, decodedPermits);
}

async function findTx(userSingles: FinalData[], decodedPermits: Decoded[]) {
  const foundTxs: [FinalData, Decoded][] = [];

  for (const single of userSingles) {
    if (single.commentTimestamp && !single.blockTimestamp) {
      const found = await findNearestTx(decodedPermits, single);
      if (!found) continue;

      single.blockTimestamp = found.blockTimestamp;
      single.txHash = found.txHash ?? "";
      foundTxs.push([single, found]);
    }
  }

  return foundTxs;
}

export async function findNearestTx(decodedPermits: Decoded[], permit: FinalData) {
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
