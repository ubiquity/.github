import { writeFile } from "fs/promises";
import { fetchPublicRepositories } from "../invoke";
import {
  CSVData,
  Contributor,
  NoPayments,
  PaymentInfo,
  Repositories,
} from "../types";

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

  const mutateDupes = keySet.map((set) => {
    if (keySet.filter((k) => k.key === set.key).length > 1) {
      const split =
        set.name.split("-")[1]?.slice(0, 6) ?? set.name?.slice(2, 8);
      return {
        key: split,
        name: set.name,
        repo: set.repo as Repositories,
      };
    }
    return set;
  });

  return mutateDupes;
}

// Removes duplicates
export function removeDuplicates<T>(arr: T[]): T[] {
  const unique = arr.filter(
    (v, i, a) =>
      a.findIndex((t) => JSON.stringify(t) === JSON.stringify(v)) === i
  );
  return unique;
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
export async function dataToCSV(
  json: PaymentInfo[] | NoPayments[] | Contributor
) {
  console.log("Converting JSON to CSV...");
  if (!json || json.length === 0) {
    return "";
  }
  let csv = "";

  try {
    if (Array.isArray(json)) {
      if (json[0].url.includes("issue")) {
        json = removeDuplicates(json as PaymentInfo[]);
        csv = json
          .sort((a: { repoName: string }, b: { repoName: string }) =>
            a.repoName.localeCompare(b.repoName)
          )
          .map((row) => Object.values(row).join(","))
          .join("\n");
      } else {
        json = removeDuplicates(json as NoPayments[]);
        csv = json
          .sort(
            (a: { lastCommitDate: string }, b: { lastCommitDate: string }) => {
              return (
                new Date(b.lastCommitDate).getTime() -
                new Date(a.lastCommitDate).getTime()
              );
            }
          )
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

// Outputs the results from `tally` and `tally-from` to three CSV files
export async function writeCSV(data: CSVData, title?: string) {
  console.log("Writing CSVs...");
  const groups = [
    {
      name: "Contributors",
      headers: ["Username", "Balance"],
      data: data.contributors,
    },
    {
      name: "All Payments",
      headers: [
        "Repository",
        "Issue #",
        "Amount",
        "Currency",
        "Payee",
        "Type",
        "URL",
      ],
      data: [...data.allPayments, ...data.allNoAssigneePayments],
    },
    {
      name: "No Payments",
      headers: ["Repository", "Archived", "Last Commit", "Message", "URL"],
      data: data.noPayments,
    },
  ];

  for (const group of groups) {
    console.log(`Writing ${group.name}...`);
    let csv = "";
    csv += `${group.headers.join(",")}\n`;
    csv += await dataToCSV(group.data);

    await writeToFile(
      `${process.cwd()}/${title ? `${title}_` : "all_repos_"}${group.name
        .toLowerCase()
        .replace(" ", "_")}.csv`,
      csv
    );
  }
}

// Outputs the CSVs to the root of the project
export async function writeToFile(fileName: string, data: string) {
  try {
    await writeFile(fileName, data);
  } catch (err) {
    console.error(err);
  }
}
