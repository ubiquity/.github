import { Command, command, metadata } from "clime";
import { fetchPublicRepositories, processRepo } from "../invoke/invoke";
import { loadingBar, writeCSV } from "../utils";

@command({
  brief: "Processes all repositories and writes repo-specific CSV files.",
  description: "Tally the UBQ airdrop for all repositories with files for each repo.",
})
export default class extends Command {
  /**
   * As TypeScript only emits metadata for target decorated by decorators,
   * if no command-line parameter is added then Clime won't know information of options and context parameter.
   * Thus a @metadata decorator that does nothing at run time is provided for preserving these metadata
   * It is required to have this @metadata decorator if no other decorator is applied to method execute.
   */
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
