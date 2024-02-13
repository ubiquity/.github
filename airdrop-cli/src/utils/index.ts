import { fetchPublicRepositories } from "../invoke/invoke";
import { CSVData, Contributor, DebugData, NoPayments, PaymentInfo, PermitDetails, Permits, Repositories } from "../types";
import { writeFile } from "fs";

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

export function findDupes<T>(arr: T[]): T[] {
  return arr.filter((item, index) => arr.indexOf(item) !== index);
}

// Removes duplicates
export function removeDuplicates<T>(arr: T[]): T[] {
  return arr.filter((v, i, a) => a.findIndex((t) => JSON.stringify(t) === JSON.stringify(v)) === i);
}

// Removes duplicate contributors and sums their balances
export function removeDuplicatesContributors(cont: Contributor): Contributor {
  return Object.entries(cont).reduce((acc, [curr, value]) => {
    acc[curr] = (acc[curr] || 0) + value;
    return acc;
  }, {} as Contributor);
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
        json = removeDuplicates(json as PaymentInfo[]);
        csv = json
          .sort((a: { repoName: string }, b: { repoName: string }) => a.repoName.localeCompare(b.repoName))
          .map((row) => Object.values(row).join(","))
          .join("\n");
      } else {
        json = removeDuplicates(json as NoPayments[]);
        csv = json
          .sort((a: { lastCommitDate: string }, b: { lastCommitDate: string }) => {
            return new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime();
          })
          .map((row) => Object.values(row).join(","))
          .join("\n");
      }
    } else {
      removeDuplicatesContributors(json);
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

export async function permitsToCSV(json: PermitDetails[]) {
  if (!json || json.length === 0) {
    return "";
  }
  let csv = "";

  try {
    json = removeDuplicates(json as PermitDetails[]);
    csv = json.map((row) => Object.values(row).join(",")).join("\n");
  } catch (err) {
    console.log(err);
  }

  return csv;
}

// Outputs the results from `tally` and `tally-from` to three CSV files
export async function writeCSV(data: CSVData, title?: string) {
  console.log("Writing CSVs...");

  console.log(
    `Lengths:\n contributor = ${Object.keys(data.contributors).length}\n allPayments = ${data.allPayments.length}\n noPayments = ${data.noPayments.length}\n permits = ${data.permits.length}\n`
  );

  const groups = [
    {
      name: "Contributors",
      headers: ["Username", "Balance"],
      data: data.contributors,
    },
    {
      name: "All Payments",
      headers: ["Repository", "Issue #", "Amount", "Currency", "Payee", "Type", "URL"],
      data: [...data.allPayments, ...data.allNoAssigneePayments],
    },
    {
      name: "No Payments",
      headers: ["Repository", "Archived", "Last Commit", "Message", "URL"],
      data: data.noPayments,
    },
    {
      name: "Permits",
      headers: ["Repository", "Issue #", "Permit"],
      data: data.permits,
    },
  ];

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
