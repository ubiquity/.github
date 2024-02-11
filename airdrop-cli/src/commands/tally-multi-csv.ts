import { Command, command, metadata, param } from "clime";
import { fetchPublicRepositories, processRepo } from "../invoke";
import { loadingBar, writeCSV } from "../utils";

@command({
  brief: "Process a single repository.",
  description: "Tally the UBQ airdrop for a single repository.",
})
export default class extends Command {
  @metadata
  async execute(
    @param({
      description: "The repository name or key.",
      required: false,
    })
    _: string
  ) {
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
