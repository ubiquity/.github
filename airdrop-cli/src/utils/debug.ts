import { formatUnits } from "viem";
import { dataToCSV, writeToFile } from ".";
import { Contributor, DebugData, PermitDetails, Permits } from "../types";
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

function formatStr(str: string) {
  // 37 permits failed to decode, below are the reasons why

  if (str.includes('%3D&network=100"')) {
    str = str.split('%3D&network=100"')[0];
  }
  if (str.includes('\\">')) {
    str = str.split('\\">')[0];
  }
  if (str.includes('%3D"')) {
    str = str.split('%3D"')[0];
  }

  if (str.includes("%3D%3D")) {
    str = str.split("%3D%3D")[0];
  }
  if (str.includes("%3D&")) {
    str = str.split("%3D&")[0];
  }
  if (str.includes("&network")) {
    str = str.split("&network")[0];
  }
  if (str.includes('\\"')) {
    str = str.split('\\"')[0];
  }
  if (str.includes('">')) {
    str = str.split('">')[0];
  }

  if (str.includes('"')) {
    str = str.split('"')[0];
  }
  if (str.includes("%3D")) {
    str = str.split("%3D")[0];
  }
  if (str.includes(")")) {
    str = str.split(")")[0];
  }
  if (str.includes(">")) {
    str = str.split(">")[0];
  }
  if (str.includes("\\")) {
    str = str.split("\\")[0];
  }
  return str;
}

async function processDecoded(data: PermitDetails[]) {
  return data.reduce((acc: PermitDetails[], current) => {
    const duplicate = acc.find((v) => {
      try {
        if (Array.isArray(v)) {
          if (Array.isArray(current)) {
            return v[0].permit.nonce === current[0].permit.nonce;
          } else {
            return v[0].permit.nonce === current.permit.nonce;
          }
        } else {
          if (Array.isArray(current)) {
            return v.permit.nonce === current[0].permit.nonce;
          } else {
            return v.permit.nonce === current.permit.nonce;
          }
        }
      } catch (err) {
        console.log(err);
        console.log(v);
        console.log(current);
        throw new Error("Error in decoding permits");
      }
    });

    if (!duplicate) {
      acc.push(current);
    }
    return acc;
  }, []);
}
export async function decodePermits(data: Permits[]) {
  const permits = Array.from(new Set(data.map((perm) => perm.url)));

  let decoded: PermitDetails[] = [];
  const failed: string[] = [];

  for (const permit of permits) {
    try {
      let worked = permit.split("=")[1].split("&")[0].replace(/"/g, "");
      worked = formatStr(worked);
      const d = atob(worked);
      const data = JSON.parse(d);
      decoded.push(data);
    } catch (err) {
      console.log("Failed to decode permit", permit, err);
      failed.push(permit);
    }
  }

  decoded = await processDecoded(decoded);

  console.log(`Started with ${permits.length} permits`);
  console.log(`Decoded ${decoded.length} permits`);

  const permitTallies = await tallyPermits(decoded);

  if (failed.length) {
    console.log(`Failed to decode ${failed.length} permits`);
    await writeToFile("./debug/repos/failed-permits.json", JSON.stringify(failed, null, 2));
  }

  const output = await permitsToCSV(decoded);

  await writeToFile("./debug/repos/decoded-permits.json", JSON.stringify(decoded, null, 2));

  await writeToFile("./all_repos_decoded-permits.csv", output);

  return { decoded, permitTallies };
}

export async function tallyPermits(data: PermitDetails[]) {
  return data.reduce((acc, permit) => {
    if (Array.isArray(permit)) {
      permit.forEach((p) => {
        if (acc[p.transferDetails.to]) {
          acc[p.transferDetails.to] += parseFloat(formatUnits(BigInt(p.transferDetails.requestedAmount), 18));
        } else {
          acc[p.transferDetails.to] = parseFloat(formatUnits(BigInt(p.transferDetails.requestedAmount), 18));
        }
      });
    } else {
      try {
        if (acc[permit.transferDetails.to]) {
          acc[permit.transferDetails.to] += parseFloat(formatUnits(BigInt(permit.transferDetails.requestedAmount), 18));
        } else {
          acc[permit.transferDetails.to] = parseFloat(formatUnits(BigInt(permit.transferDetails.requestedAmount), 18));
        }
      } catch (err) {
        console.log(err);
        console.log(permit);
        return acc;
      }
    }

    return acc;
  }, {} as Contributor);
}

export async function permitsToCSV(decodedPermits: PermitDetails[]) {
  const header = ["token", "amount", "to", "owner", "nonce", "signature"].join(",") + "\n";
  const rows = decodedPermits.map((permit) => {
    try {
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
    } catch (err) {
      console.log(err);
      console.log(permit);
      return JSON.stringify(permit);
    }
  });

  return header + rows.join("\n");
}
