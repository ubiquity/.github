import { dataToCSV, writeToFile } from ".";
import { DebugData, PaymentInfo, PermitDetails, Permits } from "../types";
import fs from "fs";

export async function parseDebugData() {
  const result: { [key: string]: DebugData[] } = {};
  const folderPath = "./debug/repos";

  const files = fs.readdirSync(folderPath);

  const typesOfMatch = [
    "no-match-but-permit-found",
    "single-permit-user-debug",
    "single-permit-zero-payment",
    "multi-permit-user-debug",
    "multi-permit-zero-payment",
  ];

  files.forEach((file: string) => {
    const filePath = `${folderPath}/${file}`;
    if (file.endsWith(".json")) {
      const fileContent = fs.readFileSync(filePath, "utf8");

      const data: DebugData[] = JSON.parse(fileContent) as DebugData[];
      if (!data.length) return console.log(`No data found in ${file}`);

      console.log(`Parsing ${file}`);

      data.forEach((entry) => {
        const typeOfMatch = entry.typeOfMatch;
        if (typesOfMatch.includes(typeOfMatch)) {
          if (result[typeOfMatch]) {
            result[typeOfMatch].push(entry);
          } else {
            result[typeOfMatch] = [entry];
          }
        }
      });
    }
  });

  const debugCountCliTable = Object.entries(result)
    .map(([key, value]) => {
      return {
        typeOfMatch: key,
        count: value.length,
      };
    })
    .sort((a, b) => b.count - a.count);

  console.table(debugCountCliTable);

  await debugCSVByTypeOfMatch(result);

  return result;
}

export async function debugCSVByTypeOfMatch(data: { [key: string]: DebugData[] } = {}): Promise<void> {
  for (const [key, value] of Object.entries(data)) {
    const csv = await dataToCSV(value);

    await writeToFile(`./debug/${key}.csv`, csv);
  }
}

export async function decodePermits(data: Permits[]) {
  const permits = data.map((perm) => perm.url);

  const decoded: PermitDetails[] = [];
  const failed: string[] = [];

  for (const permit of permits) {
    try {
      const worked = permit.split("=")[1].split("&")[0].replace(/"/g, "");
      const d = atob(worked);
      const data = JSON.parse(d);
      decoded.push(data);
    } catch (err) {
      failed.push(permit);
    }
  }

  if (failed.length) {
    console.log(`Failed to decode ${failed.length} permits`);

    await writeToFile("./debug/repos/failed-permits.json", JSON.stringify(failed, null, 2));
  }

  const output = await permitsToCSV(decoded);

  await writeToFile("./debug/repos/decoded-permits.json", JSON.stringify(decoded, null, 2));
  await writeToFile("./all_repos_decoded-permits.csv", output);

  return decoded;
}

export async function permitsToCSV(decodedPermits: PermitDetails[]) {
  const header = ["token", "amount", "to", "owner", "nonce", "signature"].join(",") + "\n";
  const rows = decodedPermits.map((permit) => {
    if (Array.isArray(permit)) {
      const token = permit[0].permit.permitted.token;
      const amount = permit[0].permit.permitted.amount;
      const to = permit[0].transferDetails.to;
      const owner = permit[0].owner;
      const nonce = permit[0].permit.nonce;
      const signature = permit[0].signature;
      return [token, amount, to, owner, nonce, signature].join(",");
    } else {
      const token = permit.permit.permitted.token;
      const amount = permit.permit.permitted.amount;
      const to = permit.transferDetails.to;
      const owner = permit.owner;
      const nonce = permit.permit.nonce;
      const signature = permit.signature;
      return [token, amount, to, owner, nonce, signature].join(",");
    }
  });

  return header + rows.join("\n");
}

// function parsePermit(permit: PermitDetails | [PermitDetails]): PermitDetails {
//   if (Array.isArray(permit)) {
//     return permit[0];
//   } else {
//     return permit;
//   }
// }

// 16/15 complexity
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function crossReferencePermitsWithPayments(permits: Permits[], payments: PaymentInfo[]) {
  console.log(`Cross referencing permits with payments...`);
  const decodedPermits = await decodePermits(permits);
  // const matchedPayments: PaymentInfo[] = [];
  // const unmatchedPayments: PaymentInfo[] = [];
  // const errors: unknown[] = [];

  console.log(`Decoded ${decodedPermits.length} permits`);
  console.log(`Found ${payments.length} payments`);

  // const tokens = [
  //   {
  //     name: "WXDAI",
  //     address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  //   },
  //   {
  //     name: "DAI",
  //     address: "0x44fA8E6f47987339850636F88629646662444217",
  //   },
  // ];

  // for (const permit of decodedPermits) {
  //   const parsedPermit = parsePermit(permit);
  //   const token = parsedPermit.permit.permitted.token;

  //   for (const payment of payments) {
  //     if (!payment) continue;

  //     const currency = tokens.find((t) => t.address === token)?.name ?? "XDAI";
  //     const paymentAmount = parseUnits(payment.paymentAmount.toString(), 18);
  //     const permitAmount = BigInt(parsedPermit.permit.permitted.amount);

  //     try {
  //       if (paymentAmount === permitAmount && payment.currency === currency) {
  //         matchedPayments.push(payment);
  //       } else {
  //         unmatchedPayments.push(payment);
  //       }
  //     } catch (err) {
  //       errors.push(err);
  //     }
  //   }
  // }

  // await processUnmatched(matchedPayments, unmatchedPayments);

  // if (errors.length) {
  //   console.log(`matching errors: `, errors);
  // }
}

// async function processUnmatched(matchedPayments: PaymentInfo[], unmatchedPayments: PaymentInfo[]) {
//   unmatchedPayments.filter((payment) => !matchedPayments.includes(payment));

//   removeDuplicates(matchedPayments);
//   removeDuplicates(unmatchedPayments);

//   if (unmatchedPayments.length) {
//     console.log(`Matched payments: `, matchedPayments.length);
//     console.log(`Unmatched payments: `, unmatchedPayments.length);
//     await writeToFile(`./debug/repos/matched-payments.json`, JSON.stringify(matchedPayments, null, 2));
//     await writeToFile(`./debug/repos/unmatched-payments.json`, JSON.stringify(unmatchedPayments, null, 2));
//   }
// }
