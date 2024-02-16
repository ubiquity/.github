import { fetchPublicRepositories } from "../invoke/invoke";
import { CSVData, Contributor, DebugData, NoPayments, PaymentInfo, Permits, Repositories } from "../types";
import { writeFile } from "fs";
import { decodePermits } from "./debug";

// Generates a unique key set for the repositories
export async function genKeySet() {
  const publicRepos = await fetchPublicRepositories("Ubiquity");

  const keySet = publicRepos.map((repo) => {
    return {
      key: repo.name.slice(0, 6),
      name: repo.name,
      repo,
    };
  });

  return keySet.map((set) => {
    if (keySet.filter((k) => k.key === set.key).length > 1) {
      const split = set.name.split("-")[1]?.slice(0, 6) ?? set.name?.slice(2, 8);
      return {
        key: split,
        name: set.name,
        repo: set.repo as Repositories,
      };
    }
    return set;
  });
}

// Loading bar for the CLI
export async function loadingBar() {
  const frames = ["| ", "/ ", "- ", "\\ "];
  let i = 0;
  return setInterval(() => {
    process.stdout.write("\r" + frames[i++]);
    i &= 3;
  }, 100);
}

// Converts data to CSV strings
export async function dataToCSV(json: DebugData[] | PaymentInfo[] | NoPayments[] | Permits[] | Contributor) {
  if (!json || json.length === 0) {
    return "";
  }
  let csv = "";

  try {
    if (Array.isArray(json)) {
      if (json[0].url.includes("issue")) {
        json = Array.from(new Set(json as PaymentInfo[]));
        csv = json
          .sort((a, b) => a.repoName.localeCompare(b.repoName))
          .map((row) => Object.values(row).join(","))
          .join("\n");
      } else {
        json = Array.from(new Set(json as NoPayments[]));
        csv = json
          .sort((a, b) => {
            return new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime();
          })
          .map((row) => Object.values(row).join(","))
          .join("\n");
      }
    } else {
      csv = Object.entries(json)
        .sort((a, b) => b[1] - a[1])
        .map((row) => row.join(","))
        .join("\n");
    }
  } catch (err) {
    console.log(err);
  }

  return csv;
}

export async function writeCSV(data: CSVData, title?: string) {
  const groups = [
    {
      name: "Contributors",
      headers: ["Address", "Balance"],
      data: (await decodePermits(data.permits)).permitTallies,
    },
  ];

  console.log(
    `Contributors: ${Object.keys(groups[0].data).length}\nAll found payments: ${data.allPayments.length}\nRepos without payments: ${data.noPayments.length}\n`
  );

  for (const group of groups) {
    console.log(`Writing ${group.name}...`);
    let csv = "";
    csv += `${group.headers.join(",")}\n`;
    const fileName = `${process.cwd()}/${title ? title + "_" : "all_repos_"}${group.name.toLowerCase().replace(" ", "_")}.csv`;
    csv += await dataToCSV(group.data);

    await writeToFile(fileName, csv);
  }
}

// Outputs the CSVs to the root of the project
export async function writeToFile(fileName: string, data: string) {
  try {
    writeFile(fileName, data, (err) => {
      if (err) {
        console.error(err);
      }
    });
  } catch (err) {
    console.error(err);
  }
}
