import { Command, command, metadata } from "clime";
import { fetchPublicRepositories, processRepo } from "../invoke/invoke";
import { loadingBar, writeCSV } from "../utils";

@command({
  brief: "Processes all repositories and writes repo-specific CSV files.",
  description: "Tally the UBQ airdrop for all repositories with files for each repo.",
})
export default class extends Command {
  @metadata
  async execute() {
    const repos = await fetchPublicRepositories();

    const since = "2023-01-01T00:00:00.000Z";
    const loader = await loadingBar();

    for (const repo of repos) {
      const data = await processRepo("Ubiquity", repo, since, true);
      if (!data) continue;
      await writeCSV(data, repo.name);
    }

    clearInterval(loader);
  }
}
