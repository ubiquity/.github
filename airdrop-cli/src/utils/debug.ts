import { parseUnits } from "viem";
import { dataToCSV, writeToFile } from ".";
import { DebugData, PaymentInfo, PermitDetails, Permits } from "../types";
import fs from "fs";

export async function parseDebugData() {
  const result: { [key: string]: DebugData[] } = {};
  const folderPath = "./debug/repos";

  const files = fs.readdirSync(folderPath);

  const typesOfMatch = ["permit-has-newline", "more-payments-than-users", "no-permit-but-match-found", "no-match-but-permit-found"];

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
  const errors: any[] = [];

  for (const permit of permits) {
    try {
      let worked = permit.split("=")[1].split("&")[0].replace(/"/g, "");
      let d = atob(worked);
      const data = JSON.parse(d);
      decoded.push(data);
    } catch (err) {
      errors.push(err);
    }
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

  const csvContent = header + rows.join("\n");
  return csvContent;
}
const tokens = [
  {
    name: "WXDAI",
    address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  },
  {
    name: "DAI",
    address: "0x44fA8E6f47987339850636F88629646662444217",
  },
];

export async function crossReferencePermitsWithPayments(permits: Permits[], payments: PaymentInfo[]) {
  console.log(`Cross referencing permits with payments...`);

  const decodedPermits = await decodePermits(permits);
  const parsePermit = (permit: PermitDetails | [PermitDetails]): PermitDetails => {
    if (Array.isArray(permit)) {
      return permit[0];
    } else {
      return permit;
    }
  };

  const matchedPayments: PaymentInfo[] = [];
  const errors: any[] = [];

  for (const permit of decodedPermits) {
    const parsedPermit = parsePermit(permit);
    const token = parsedPermit.permit.permitted.token;

    for (const payment of payments) {
      if (!payment) continue;

      const currency = tokens.find((t) => t.address === token)?.name ?? "XDAI";

      try {
        if (parseUnits(payment.paymentAmount.toString(), 18) === BigInt(parsedPermit.permit.permitted.amount) && payment.currency === currency) {
          matchedPayments.push(payment);
        }
      } catch (err) {
        errors.push(err);
      }
    }
  }

  const unmatchedPayments = payments.filter((payment) => !matchedPayments.includes(payment));

  if (unmatchedPayments.length > 0) {
    writeToFile(`./debug/repos/unmatched-payments.json`, JSON.stringify(unmatchedPayments, null, 2));
  }

  if (errors.length) {
    console.log(`matching errors: `, errors);
  }
}
