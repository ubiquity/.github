import { dataToCSV, writeToFile } from ".";
import { DebugData } from "../types";
import fs from "fs";

export async function parseDebugData() {
  const result: { [key: string]: DebugData[] } = {};
  const folderPath = "./debug/repos";

  const files = fs.readdirSync(folderPath);

  const typesOfMatch = [
    "match-colon-match-claim-bot-author",
    "rematch-bot-author",
    "no-colon-claim-match-no-rematch-bot-author",
    "no-colon-no-rematch-match-bot-author",
    "altMatch-bot-author",
    "match-no-bot-author",
    "altMatch-no-bot-author",
  ];

  files.forEach((file: string) => {
    const filePath = `${folderPath}/${file}`;
    if (file.endsWith(".json")) {
      const fileContent = fs.readFileSync(filePath, "utf8");

      const data: DebugData[] = file.endsWith(".json") ? JSON.parse(fileContent) : {};

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
