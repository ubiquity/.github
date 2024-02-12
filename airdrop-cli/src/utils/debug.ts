import { dataToCSV, writeToFile } from ".";
import { DebugData } from "../types";
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

// export async function validateNonPayments(data: DebugData[]) {
//   const result: DebugData[] = [];

//   return result;
// }
